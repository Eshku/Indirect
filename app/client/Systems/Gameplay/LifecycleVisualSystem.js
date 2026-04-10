const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { lifecycleState, viewable, visibility, isPooled } = ecs.getComponentIDs()

const { LayerFactorySystem } = ecs.getSystemIDs()

const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')

/**
 * Manages the visual state for pooled entities.
 * It reacts to changes in `LifecycleState` to hide or show sprites.
 *
 * - On `ACTIVE`: Ensures the entity's sprite is visible.
 * - On `DYING`: Hides the sprite and transitions the entity to the `POOLED` state.
 */
export class LifecycleVisualSystem {
	static runsAfter = [LayerFactorySystem]
	static dependencies = {
		update: {
			reads: [lifecycleState, viewable, visibility],
			writes: [visibility],
		},
	}

	init() {
		this.lifecycleQuery = this.getQuery({
			with: [lifecycleState, viewable, visibility],
			// Any structural change involving `isPooled` is always accompanied by a data
			// change to `lifecycleState`. Therefore, we only need to react to `lifecycleState`
			// modifications to catch all relevant visual state changes.
			modified: [lifecycleState],
		})
		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ currentTick, lastTick }) {
		const changedChunkIds = this.lifecycleQuery.getChunks(lastTick, currentTick)
		for (let i = 0; i < changedChunkIds.length; i++) {
			const chunkId = changedChunkIds[i]
			// Use getDirty for a narrow-phase check on which entities were modified.
			const changedCount = this.getDirty(chunkId, lifecycleState, lastTick, currentTick, this.scratchBuffer)
			if (changedCount === 0) continue

			const states = this.getComponentData(chunkId, lifecycleState)
			const visibilities = this.getComponentData(chunkId, visibility)

			let wasChunkModified = false

			// Now, iterate only over the entities that actually changed.
			for (let j = 0; j < changedCount; j++) {
				const indexInChunk = this.scratchBuffer[j]
				const flags = states.flags[indexInChunk]
				const isCurrentlyVisible = visibilities.isVisible[indexInChunk] === 1

				// When an entity becomes ACTIVE, ensure it is visible.
				// The PoolingSystem is now responsible for making it invisible when it enters the pool.
				if ((flags & LIFECYCLE.ACTIVE) !== 0) {
					if (!isCurrentlyVisible) {
						visibilities.isVisible[indexInChunk] = 1 // true
						wasChunkModified = true
					}
				}
			}
			if (wasChunkModified) {
				this.markComponentDirty(chunkId, visibility, currentTick)
			}
		}
	}
}
