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
		const playerChunkIds = this.playerQuery.getChunks()
		if (playerChunkIds.length > 0) {
			const playerChunkId = playerChunkIds[0]
			if (this.getChunkSize(playerChunkId) > 0) {
				const playerPositions = this.getComponentData(playerChunkId, position)
				playerX = playerPositions.x[0]
				playerY = playerPositions.y[0]
			}
		}

		let totalRefund = 0

		const enemyChunkIds = this.enemyQuery.getChunks()
		for (let i = 0; i < enemyChunkIds.length; i++) {
			const chunkId = enemyChunkIds[i]
			const positions = this.getComponentData(chunkId, position)
			const costs = this.getComponentData(chunkId, threatCost)
			const states = this.getComponentData(chunkId, lifecycleState)
			const chunkSize = this.getChunkSize(chunkId)
			let wasChunkModified = false

			for (let j = 0; j < chunkSize; j++) {
				if ((states.flags[j] & LIFECYCLE.ACTIVE) === 0) continue

				const dx = positions.x[j] - playerX
				const dy = positions.y[j] - playerY
				const distSq = dx * dx + dy * dy

				if (distSq > CULLING_DISTANCE_SQ) {
					totalRefund += costs.value[j]
					// Directly set lifecycleState to DYING and mark dirty for immediate reactivity.
					// This ensures LifecycleVisualSystem (running in the same frame) sees the change.
					states.flags[j] = LIFECYCLE.DYING
					// Mark the specific entity as dirty for narrow-phase checks.
					this.markEntityDirty(chunkId, j, lifecycleState, currentTick)
					wasChunkModified = true
				}
			}
			// If any entity in this chunk had its lifecycle state changed, we must perform a
			// broad-phase dirty mark so that reactive systems like PoolingSystem will process this chunk.
			if (wasChunkModified) {
				this.markComponentDirty(chunkId, lifecycleState, currentTick)
			}
		}

		if (totalRefund > 0) {
			// The director is a singleton, so this loop will run once.
			const directorChunkIds = this.directorQuery.getChunks()
			for (let i = 0; i < directorChunkIds.length; i++) {
				const director = this.getComponentData(directorChunkIds[i], spawnDirector)
				director.threatBudget[0] = director.threatBudget[0] + totalRefund
			}
		}
	}
}
