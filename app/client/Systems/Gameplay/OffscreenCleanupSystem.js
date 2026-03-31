const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { enemyTag, playerTag, position, isPooled, lifecycleState, threatCost, spawnDirector } = ecs.getComponentIDs()

const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')

// Define a large distance outside of which enemies will be culled.
// This should be significantly larger than the screen + spawn radius.
const CULLING_DISTANCE = 4000
const CULLING_DISTANCE_SQ = CULLING_DISTANCE * CULLING_DISTANCE

/**
 * A system that runs periodically to clean up enemies that are very far
 * from the player. This prevents an infinite accumulation of off-screen
 * entities, saving resources. Culled enemies have their threat cost
 * refunded to the SpawnDirector.
 */
export class OffscreenCleanupSystem {
	static dependencies = {
		// This system modifies the director's budget and marks entities for pooling.
		update: {
			reads: [position, threatCost, spawnDirector],
			writes: [lifecycleState, spawnDirector],
		},
	}

	init() {
		// Query for all active enemies that have a threat cost.
		this.enemyQuery = this.getQuery({
			with: [enemyTag, position, threatCost, lifecycleState],
			without: [isPooled],
		})

		// Singleton queries for the player and the director.
		this.playerQuery = this.getQuery({ with: [playerTag, position] })
		this.directorQuery = this.getQuery({ with: [spawnDirector] })

		this.playerId = this.playerQuery.getSingleEntity()
		this.directorId = this.directorQuery.getSingleEntity()
	}

	update({ currentTick }) {
		let playerX = 0
		let playerY = 0
		for (const chunk of this.playerQuery.iter()) {
			playerX = chunk.componentData[position].x[0]
			playerY = chunk.componentData[position].y[0]
		}

		let totalRefund = 0

		for (const chunk of this.enemyQuery.iter()) {
			const positions = chunk.componentData[position]
			const costs = chunk.componentData[threatCost]
			const states = chunk.componentData[lifecycleState]

			for (let i = 0; i < chunk.size; i++) {
				if ((states.flags[i] & LIFECYCLE.ACTIVE) === 0) continue

				const dx = positions.x[i] - playerX
				const dy = positions.y[i] - playerY
				const distSq = dx * dx + dy * dy

				if (distSq > CULLING_DISTANCE_SQ) {
					totalRefund += costs.value[i]
					// Directly set lifecycleState to DYING and mark dirty for immediate reactivity.
					// This ensures LifecycleVisualSystem (running in the same frame) sees the change.
					states.flags[i] = LIFECYCLE.DYING
					chunk.markEntityDirty(i, lifecycleState, currentTick)
				}
			}
		}

		if (totalRefund > 0) {
			// The director is a singleton, so this loop will run once.
			for (const chunk of this.directorQuery.iter()) {
				const director = chunk.componentData[spawnDirector]
				director.threatBudget[0] = director.threatBudget[0] + totalRefund
			}
		}
	}
}
