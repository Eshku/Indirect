const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { playerTag, enemyTag, position, movementIntent, isPooled, aiParameters } = ecs.getComponentIDs()

/**
 * An AI system that makes enemies swarm and spiral towards the player using an "Orbiting Bias" method.
 * This prevents clumping by giving each enemy a slightly divergent path, blending a direct "seek"
 * vector with a perpendicular "tangent" vector.
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
			const entities = this.getEntities(chunkId)
			const enemyPositions = this.getComponentData(chunkId, position)
			const enemyIntents = this.getComponentData(chunkId, movementIntent)
			const enemyAIParams = this.getComponentData(chunkId, aiParameters)
			const chunkSize = this.getChunkSize(chunkId)

			for (let j = 0; j < chunkSize; j++) {
				const seekX = playerX - enemyPositions.x[j]
				const seekY = playerY - enemyPositions.y[j]

				const length = Math.sqrt(seekX * seekX + seekY * seekY)

				if (length < 1e-6) continue // Avoid division by zero if on top of player

				const invLength = 1 / length
				const normalizedSeekX = seekX * invLength
				const normalizedSeekY = seekY * invLength

				// Use bitwise AND for a faster even/odd check.
				// This gives a deterministic but unique orbit direction per entity.
				// If entityId is even, (... & 1n) is 0n -> 1 - 2 * 0 = 1
				// If entityId is odd,  (... & 1n) is 1n -> 1 - 2 * 1 = -1
				const orbitDirection = 1 - 2 * Number(entities[j] & 1n)

				// Calculate the base perpendicular tangent vector (90-degree rotation)
				const baseTangentX = -normalizedSeekY * orbitDirection
				const baseTangentY = normalizedSeekX * orbitDirection

				// Introduce angular spread for more organic movement.
				// Use a deterministic seed from the entity ID for the angle.
				// 1023n is used to get a value from 0 to 1023, then normalized to 0-1.
				const angleSeed = Number(entities[j] & 1023n) / 1023

				// Make the angle vary over time for a more dynamic "wobble".
				const wobbleFrequency = enemyAIParams.orbitWobbleFrequency[j]
				const timePhase = currentTick * wobbleFrequency * 0.01 // 0.01 is a tuning constant

				// Use a sine wave for smooth oscillation. The angleSeed provides a unique phase offset for each entity.
				const orbitAngleSpread = enemyAIParams.orbitAngleSpread[j]
				const angle = Math.sin(timePhase + angleSeed * Math.PI * 2) * orbitAngleSpread

				const cosAngle = Math.cos(angle)
				const sinAngle = Math.sin(angle)

				// Rotate the base tangent vector by the calculated angle
				const variedTangentX = baseTangentX * cosAngle - baseTangentY * sinAngle
				const variedTangentY = baseTangentX * sinAngle + baseTangentY * cosAngle

				// Read the orbit bias from the component for this specific enemy.
				const orbitBias = enemyAIParams.orbitBias[j]

				// Combine seek and tangent vectors
				const finalX = normalizedSeekX + variedTangentX * orbitBias
				const finalY = normalizedSeekY + variedTangentY * orbitBias

				//inverse length of the combined vector mathematically.
				// The length of (normalizedSeek + tangent * bias) is sqrt(1^2 + bias^2).
				const invFinalLength = 1 / Math.sqrt(1 + orbitBias * orbitBias)
				enemyIntents.desiredX[j] = finalX * invFinalLength
				enemyIntents.desiredY[j] = finalY * invFinalLength
			}
		}
	}
}
