const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { health, lifecycleState, playerTag } = ecs.getComponentIDs()

const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')
const { DamageSystem } = ecs.getSystemIDs()

/**
 * Monitors entities with health and marks them as 'DYING' when their health drops to zero or below.
 * This system acts as the bridge between taking damage and entering the pooling/cleanup pipeline.
 */
export class HealthSystem {
	static dependencies = {
		// Must run after any system that can modify health (e.g., DamageSystem).
		runsAfter: [DamageSystem],
		update: {
			reads: [health, lifecycleState],
			writes: [lifecycleState],
		},
	}

	init() {
		// A reactive query that only triggers for entities whose health has changed.
		this.healthQuery = this.getQuery({
			with: [health, lifecycleState],
			modified: [health],
		})

		this.playerQuery = this.getQuery({ with: [playerTag] })
		this.playerId = this.playerQuery.getSingleEntity()

		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ currentTick, lastTick }) {
		const changedChunkIds = this.healthQuery.getChunks(lastTick, currentTick)

		for (let i = 0; i < changedChunkIds.length; i++) {
			const chunkId = changedChunkIds[i]
			const healths = this.getComponentData(chunkId, health)
			const states = this.getComponentData(chunkId, lifecycleState)
			const entities = this.getEntities(chunkId)
			const changedCount = this.getDirty(chunkId, health, lastTick, currentTick, this.scratchBuffer)
			let wasChunkModified = false

			for (let j = 0; j < changedCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				// Check if health has dropped to or below zero.
				if (healths.current[indexInChunk] <= 0) {
					// Only mark as DYING if it's currently ACTIVE. This prevents
					// redundant commands for entities already dying or pooled.
					if ((states.flags[indexInChunk] & LIFECYCLE.ACTIVE) !== 0) {
						states.flags[indexInChunk] = LIFECYCLE.DYING
						this.markEntityDirty(chunkId, indexInChunk, lifecycleState, currentTick)
						wasChunkModified = true
					}
				}
			}

			// If any entity in this chunk had its lifecycle state changed, we must perform a
			// broad-phase dirty mark so that reactive systems like PoolingSystem will process this chunk.
			if (wasChunkModified) {
				this.markComponentDirty(chunkId, lifecycleState, currentTick)
			}
		}
	}
}
