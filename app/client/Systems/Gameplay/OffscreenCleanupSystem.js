const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { enemyTag, playerTag, position, lifecycleState, threatCost, spawnDirector, visibility, tint } = ecs.getComponentIDs()

const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')

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
			writes: [lifecycleState, spawnDirector, visibility, tint],
		},
	}

	init() {
		// Query for all active enemies that have a threat cost.
		this.enemyQuery = this.getQuery({
			with: [enemyTag, position, threatCost, lifecycleState, visibility, tint],
		})

		// Singleton queries for the player and the director.
		this.playerQuery = this.getQuery({ with: [playerTag, position] })
		this.directorQuery = this.getQuery({ with: [spawnDirector] })

		this.playerId = this.playerQuery.getSingleEntity()
		this.directorId = this.directorQuery.getSingleEntity()

		this.isActiveMaskId = this.getMaskId('isActive')
		this.isDeadMaskId = this.getMaskId('isDead')
		this.scratchBuffer = this.createScratchBuffer()
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
			const visibilities = this.getComponentData(chunkId, visibility)
			const tints = this.getComponentData(chunkId, tint)
			let wasChunkModified = false

			const activeCount = this.getIndicesFromMask(this.isActiveMaskId, chunkId, this.scratchBuffer)
			for (let j = 0; j < activeCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				const dx = positions.x[indexInChunk] - playerX
				const dy = positions.y[indexInChunk] - playerY
				const distSq = dx * dx + dy * dy

				if (distSq > CULLING_DISTANCE_SQ) {
					totalRefund += costs.value[indexInChunk]
					// Instantly mark for pooling, make invisible, and reset tint.
					this.clearBit(this.isActiveMaskId, chunkId, indexInChunk)
					this.setBit(this.isDeadMaskId, chunkId, indexInChunk)
					states.state[indexInChunk] = LIFECYCLE.DEAD
					visibilities.isVisible[indexInChunk] = 0
					tints.r[indexInChunk] = 1.0
					tints.g[indexInChunk] = 1.0
					tints.b[indexInChunk] = 1.0
					tints.a[indexInChunk] = 1.0
					// Mark the specific entity as dirty for narrow-phase checks.
					this.markEntityDirty(chunkId, indexInChunk, lifecycleState, currentTick)
					this.markEntityDirty(chunkId, indexInChunk, visibility, currentTick)
					this.markEntityDirty(chunkId, indexInChunk, tint, currentTick)
					wasChunkModified = true
				}
			}
			// If any entity in this chunk had its lifecycle state changed, we must perform a
			// broad-phase dirty mark so that reactive systems like PoolingSystem will process this chunk.
			if (wasChunkModified) {
				this.markComponentDirty(chunkId, lifecycleState, currentTick)
				this.markComponentDirty(chunkId, visibility, currentTick)
				this.markComponentDirty(chunkId, tint, currentTick)
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
