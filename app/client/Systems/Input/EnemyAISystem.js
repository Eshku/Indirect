const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { playerTag, enemyTag, position, movementIntent } = ecs.getTypeIDs()

/**
 * A simple AI system that makes enemies move towards the player.
 * It queries for all enemies with a MovementIntent and the single player entity.
 * For each enemy, it calculates the normalized direction vector towards the player
 * and writes it into the enemy's MovementIntent component.
 */
export class EnemyAISystem {
	static dependencies = {
		update: {
			writes: [movementIntent],
		},
	}

	init() {
		// A query for all enemies that are capable of moving.
		this.enemyQuery = this.getQuery({
			with: [enemyTag, position, movementIntent],
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
		const playerPos = this.getComponent(this.playerId, position)

		const { x: playerX, y: playerY } = playerPos

		for (const chunk of this.enemyQuery.iter()) {
			const enemyPositions = chunk.componentData[position]
			const enemyIntents = chunk.componentData[movementIntent]

			for (let i = 0; i < chunk.size; i++) {
				const dx = playerX - enemyPositions.x[i]
				const dy = playerY - enemyPositions.y[i]

				const length = Math.sqrt(dx * dx + dy * dy)

				// Avoid division by zero, but otherwise always update.
				const invLength = length > 0 ? 1 / length : 0
				enemyIntents.desiredX[i] = dx * invLength
				enemyIntents.desiredY[i] = dy * invLength
			}
		}
	}
}
