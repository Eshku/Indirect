const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { lifecycleState, scale } = ecs.getComponentIDs()
const { SyncTransforms } = ecs.getSystemIDs()
const { Easing } = await import(`@core/utils/easing.js`)

const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')

export class SpawnAnimationSystem {
	static runsBefore = [SyncTransforms]

	static dependencies = {
		update: {
			reads: [lifecycleState],
			writes: [lifecycleState, scale],
		},
	}

	init() {
		// Get mask IDs for lifecycle states
		this.isSpawningMaskId = this.getMaskId('isSpawning')
		this.isActiveMaskId = this.getMaskId('isActive')

		this.query = this.getQuery({
			with: [lifecycleState, scale],
		})

		this.scratchBuffer = this.createScratchBuffer()

	}

	update({ deltaTime, currentTick }) {
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const states = this.getComponentData(chunkId, lifecycleState)
			const scales = this.getComponentData(chunkId, scale)
			let wasScaleChunkModified = false
			let wasStateChunkModified = false

			// Get the indices of entities in the SPAWNING state for this chunk.
			const spawningCount = this.getIndicesFromMask(this.isSpawningMaskId, chunkId, this.scratchBuffer)

			for (let j = 0; j < spawningCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				const newTime = Math.max(0, states.timer[indexInChunk] - deltaTime)
				states.timer[indexInChunk] = newTime

				// Progress goes from 0 to 1 as timer goes from duration to 0.
				const progress = 1.0 - newTime / states.duration[indexInChunk]
				// Use an easing function for a more appealing animation.
				const easedProgress = Easing.easeOutQuad(progress)
				const newScale = 0.01 + easedProgress * 0.99

				scales.x[indexInChunk] = newScale
				scales.y[indexInChunk] = newScale
				this.markEntityDirty(chunkId, indexInChunk, scale, currentTick)
				wasScaleChunkModified = true

				if (newTime <= 0) {
					// Transition from SPAWNING to ACTIVE
					this.clearBit(this.isSpawningMaskId, chunkId, indexInChunk)
					this.setBit(this.isActiveMaskId, chunkId, indexInChunk)
					states.state[indexInChunk] = LIFECYCLE.ACTIVE
					// Ensure final scale is exactly 1.0
					scales.x[indexInChunk] = 1.0
					scales.y[indexInChunk] = 1.0
					this.markEntityDirty(chunkId, indexInChunk, lifecycleState, currentTick)
					wasStateChunkModified = true
				}
			}

			if (wasScaleChunkModified) {
				this.markComponentDirty(chunkId, scale, currentTick)
			}
			if (wasStateChunkModified) {
				this.markComponentDirty(chunkId, lifecycleState, currentTick)
			}
		}
	}
}