const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { lifecycleState, hitFlash } = ecs.getComponentIDs()

const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')

/**
 * A generalized system that manages the final step of entity pooling.
 * It queries for entities whose state has been set to 'DEAD' by another system (e.g., HealthSystem, ProjectileLifetimeSystem)
 * and transitions them to the 'POOLED' state. This is a non-structural data change.
 * This decouples the logic of "deciding to die" from the mechanics of "entering the pool".
 */
export class PoolingSystem {
	static dependencies = {
		update: {
			reads: [lifecycleState],
			writes: [lifecycleState],
		},
	}

	init() {
		// Get mask IDs for lifecycle states
		this.isDeadMaskId = this.getMaskId('isDead')
		this.isPooledMaskId = this.getMaskId('isPooled')

		// A single query for all entities that can be pooled.
		this.poolableQuery = this.getQuery({
			with: [lifecycleState],
		})

		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ currentTick, lastTick }) {
		const chunkIds = this.poolableQuery.getChunks()

		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const states = this.getComponentData(chunkId, lifecycleState)
			const hitFlashes = this.getComponentData(chunkId, hitFlash) // May be undefined
			let wasChunkModified = false

			const deadCount = this.getIndicesFromMask(this.isDeadMaskId, chunkId, this.scratchBuffer)

			for (let j = 0; j < deadCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				// Transition from DEAD to POOLED
				this.clearBit(this.isDeadMaskId, chunkId, indexInChunk)
				this.setBit(this.isPooledMaskId, chunkId, indexInChunk)
				states.state[indexInChunk] = LIFECYCLE.POOLED
				this.markEntityDirty(chunkId, indexInChunk, lifecycleState, currentTick)

				// If the entity has a hitFlash component and it's enabled, disable it upon pooling.
				if (hitFlashes && this.isComponentEnabled(chunkId, indexInChunk, hitFlash)) {
					this.disableComponent(chunkId, indexInChunk, hitFlash)
				}
				wasChunkModified = true
			}

			if (wasChunkModified) {
				this.markComponentDirty(chunkId, lifecycleState, currentTick)
			}
		}
	}
}
