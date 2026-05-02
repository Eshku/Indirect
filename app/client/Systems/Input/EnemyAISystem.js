const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { playerTag, enemyTag, position, movementIntent, isPooled, aiParameters, circleCollider } = ecs.getComponentIDs()

/**
 * A high-performance AI system that creates a dynamic, non-clumping enemy swarm.
 *
 * --- GOALS & PHILOSOPHY ---
 * The primary goal is to manage thousands of enemies efficiently without them forming a "super blob".
 * This is achieved with a proactive, stateless, and branchless approach that
 * avoids any expensive neighbor lookups or collision-based separation logic. Each enemy's AI is
 * calculated independently, making the system highly scalable and parallelizable.
 *
 * --- CORE ALGORITHM: ORBITING BIAS & WOBBLE ---
 * Instead of moving directly towards the player, each enemy's "seek" vector is rotated by a
 * calculated angle. This angle is a combination of:
 * 1.  A base "Orbit Bias": A per-entity value that determines its general tendency to spiral
 *     clockwise or counter-clockwise.
 * 2.  A time-based "Wobble": A sinusoidal oscillation that adds a weaving motion, making the
 *     swarm feel more organic and less predictable.
 *
 * --- DETERMINISTIC VARIETY (LCG-like Method) ---
 * To give each enemy a unique "personality" (orbit direction, wobble frequency, etc.), we derive
 * multiple pseudo-random values from a single `randomSeed` that is generated once at spawn time.
 * This is done by multiplying the seed by different "magic" prime-like numbers and taking the
 * fractional part (`(seed * magic) % 1.0`). This is a highly performant technique for generating
 * deterministic, uncorrelated values, similar in principle to a Linear Congruential Generator (LCG)
 * and commonly used in shader programming.
 *
 * --- STOP DISTANCE ---
 * The system also implements a `stopDistance` around the player. When an enemy enters this radius,
 * its movement intent is branchlessly scaled to zero, preventing it from getting stuck on the
 * player and creating a natural "ring of threat".
 */
export class EnemyAISystem {
	static dependencies = {
		update: {
			reads: [position, aiParameters],
			writes: [movementIntent],
		},
	}

	init() {
		// A query for all enemies that are capable of moving.
		this.enemyQuery = this.getQuery({
			with: [enemyTag, position, movementIntent, aiParameters],
			without: [isPooled],
		})

		// A singleton query to find the player.
		this.playerQuery = this.getQuery({
			with: [playerTag, position],
		})

		this.playerId = this.playerQuery.getSingleEntity()

		// --- Calculate Stop Distance ---
		// We want enemies to stop at a certain distance from the player to prevent
		// them from clumping directly on top. 
		const playerChunkIds = this.playerQuery.getChunks()
		const playerChunkId = playerChunkIds[0]
		const playerColliders = this.getComponentData(playerChunkId, circleCollider)
		const playerRadius = playerColliders.radius[0]

		// A good stop distance is the player's radius plus a small buffer.
		// We'll use the player's radius itself as a buffer, effectively stopping
		// enemies one "player-width" away from the player's center.
		
		// This stops at exact moment where enemies can still attack player - distance <= 32 for collision detection and stop distance.
		this.stopDistance = playerRadius * 2 // e.g., 16 * 2 = 32
	}

	update({ currentTick }) {
		let playerX
		let playerY

		const playerChunkIds = this.playerQuery.getChunks()

		const playerChunkId = playerChunkIds[0]

		const playerPositions = this.getComponentData(playerChunkId, position)
		
		playerX = playerPositions.x[0]
		playerY = playerPositions.y[0]

		const enemyChunkIds = this.enemyQuery.getChunks()

		for (let i = 0; i < enemyChunkIds.length; i++) {
			const chunkId = enemyChunkIds[i]
			const enemyPositions = this.getComponentData(chunkId, position)
			const enemyIntents = this.getComponentData(chunkId, movementIntent)
			const enemyAIParams = this.getComponentData(chunkId, aiParameters)
			const chunkSize = this.getChunkSize(chunkId)

			for (let j = 0; j < chunkSize; j++) {
				const seekX = playerX - enemyPositions.x[j]
				const seekY = playerY - enemyPositions.y[j]

				const length = Math.sqrt(seekX * seekX + seekY * seekY)

				// This is a branchless way to get 0 if length is less than stop distance.
				const shouldMove = Number(length > this.stopDistance)

				// Add a small epsilon to length to prevent division by zero. It's possible for the player to move
				// on top of a stationary enemy, causing length to become zero.
				const invLength = 1 / (length + 1e-9)
				const normalizedSeekX = seekX * invLength
				const normalizedSeekY = seekY * invLength

				// --- Per-Entity Variation Generation ---
				// We use a single random seed, generated once at spawn time and stored in the aiParameters component.
				// This is much more performant than hashing every frame. We derive all needed variations from this
				// single seed by taking the fractional part of multiplications with arbitrary prime-like numbers.
				const seed = enemyAIParams.randomSeed[j]

				// --- Pseudo-Random Number Generation ---
				// Derive 4 different pseudo-random numbers from the single seed.
				// This uses `x - Math.floor(x)` to get the fractional part, which is a well-known
				// and significantly faster alternative to the floating-point modulo operator (`% 1.0`).
				const m1 = seed * 12.9898
				const m2 = seed * 78.233
				const m3 = seed * 34.437
				const m4 = seed * 55.123

				const dirSeed = m1 - Math.floor(m1)
				const angleSeed = m2 - Math.floor(m2)
				const freqSeed = m3 - Math.floor(m3)
				const strengthSeed = m4 - Math.floor(m4)

				const orbitDirection = dirSeed * 2 - 1 // Map to range [-1, 1]
				const freqMultiplier = 0.5 + freqSeed * 1.5
				const strengthMultiplier = 0.75 + strengthSeed * 0.5

				// Rotates the seek vector by a calculated angle,
				// allowing for bidirectional orbiting.
				// 1. Calculate the base orbit angle for this entity.
				const baseOrbitBias = enemyAIParams.orbitBias[j]
				const orbitBias = baseOrbitBias * strengthMultiplier
				const baseOrbitAngle = orbitDirection * orbitBias // A signed angle in radians

				// 2. Calculate the time-based "wobble" angle.
				const baseWobbleFrequency = enemyAIParams.orbitWobbleFrequency[j]
				const timePhase = currentTick * baseWobbleFrequency * freqMultiplier * 0.01 // 0.01 is a tuning constant
				const orbitAngleSpread = enemyAIParams.orbitAngleSpread[j]
				const wobbleAngle = Math.sin(timePhase + angleSeed * Math.PI * 2) * orbitAngleSpread

				// 3. Combine the base orbit and wobble into a final angle and rotate the seek vector.
				const finalAngle = baseOrbitAngle + wobbleAngle
				const cosFinal = Math.cos(finalAngle)
				const sinFinal = Math.sin(finalAngle)

				const rotatedX = normalizedSeekX * cosFinal - normalizedSeekY * sinFinal
				const rotatedY = normalizedSeekX * sinFinal + normalizedSeekY * cosFinal

				// The final intent is scaled by `shouldMove`. If the enemy is too close,
				// `shouldMove` is 0, and the intent becomes zero, stopping the enemy.
				enemyIntents.desiredX[j] = rotatedX * shouldMove
				enemyIntents.desiredY[j] = rotatedY * shouldMove
			}
		}
	}
}
