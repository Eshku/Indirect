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

		// Find and cache the player's entity ID using the new convenience method.
		this.playerId = this.playerQuery.getSingleEntity()

		if (!this.playerId) {
			console.error('EnemyAISystem: Could not find player entity during initialization.')
		}
	}

	update({ currentTick }) {
		let playerX = 0
		let playerY = 0

		// Get player position. This is a singleton query and will only run once.
		for (const chunk of this.playerQuery.iter()) {
			playerX = chunk.componentData[position].x[0]
			playerY = chunk.componentData[position].y[0]
		}

		for (const chunk of this.enemyQuery.iter()) {
			const entities = chunk.entities
			const enemyPositions = chunk.componentData[position]
			const enemyIntents = chunk.componentData[movementIntent]
			const enemyAIParams = chunk.componentData[aiParameters]

			for (let i = 0; i < chunk.size; i++) {
				const seekX = playerX - enemyPositions.x[i]
				const seekY = playerY - enemyPositions.y[i]

				const length = Math.sqrt(seekX * seekX + seekY * seekY)

				if (length < 1e-6) continue // Avoid division by zero if on top of player

				const invLength = 1 / length
				const normalizedSeekX = seekX * invLength
				const normalizedSeekY = seekY * invLength

				// Use bitwise AND for a faster even/odd check.
				// This gives a deterministic but unique orbit direction per entity.
				// If entityId is even, (... & 1n) is 0n -> 1 - 2 * 0 = 1
				// If entityId is odd,  (... & 1n) is 1n -> 1 - 2 * 1 = -1
				const orbitDirection = 1 - 2 * Number(entities[i] & 1n)

				// Calculate the base perpendicular tangent vector (90-degree rotation)
				const baseTangentX = -normalizedSeekY * orbitDirection
				const baseTangentY = normalizedSeekX * orbitDirection

				// Introduce angular spread for more organic movement.
				// Use a deterministic seed from the entity ID for the angle.
				// 1023n is used to get a value from 0 to 1023, then normalized to 0-1.
				const angleSeed = Number(entities[i] & 1023n) / 1023

				// Make the angle vary over time for a more dynamic "wobble".
				const wobbleFrequency = enemyAIParams.orbitWobbleFrequency[i]
				const timePhase = currentTick * wobbleFrequency * 0.01 // 0.01 is a tuning constant

				// Use a sine wave for smooth oscillation. The angleSeed provides a unique phase offset for each entity.
				const orbitAngleSpread = enemyAIParams.orbitAngleSpread[i]
				const angle = Math.sin(timePhase + angleSeed * Math.PI * 2) * orbitAngleSpread

				const cosAngle = Math.cos(angle)
				const sinAngle = Math.sin(angle)

				// Rotate the base tangent vector by the calculated angle
				const variedTangentX = baseTangentX * cosAngle - baseTangentY * sinAngle
				const variedTangentY = baseTangentX * sinAngle + baseTangentY * cosAngle

				// Read the orbit bias from the component for this specific enemy.
				const orbitBias = enemyAIParams.orbitBias[i]

				// Combine seek and tangent vectors
				const finalX = normalizedSeekX + variedTangentX * orbitBias
				const finalY = normalizedSeekY + variedTangentY * orbitBias

				// Optimization: Avoid the second sqrt by calculating the inverse length of the combined vector mathematically.
				// The length of (normalizedSeek + tangent * bias) is sqrt(1^2 + bias^2).
				const invFinalLength = 1 / Math.sqrt(1 + orbitBias * orbitBias)
				enemyIntents.desiredX[i] = finalX * invFinalLength
				enemyIntents.desiredY[i] = finalY * invFinalLength
			}
		}
	}
}
