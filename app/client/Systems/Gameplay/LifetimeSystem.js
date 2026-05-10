const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { lifetime, lifecycleState, visibility, tint} = ecs.getComponentIDs()

const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')
const DEATH_ANIMATION_DURATION = 0.25 // A short, snappy animation for effects fizzling out.

/**
 * Destroys entities after their `lifetime` component's timer expires.
 */
export class LifetimeSystem {
	static dependencies = {
		update: {
			reads: [lifetime, lifecycleState],
			writes: [lifecycleState],
		},
	}

	init() {
		this.query = this.getQuery({
			with: [lifetime, lifecycleState, visibility, tint],
		})
		this.isActiveMaskId = this.getMaskId('isActive')
		this.isDyingMaskId = this.getMaskId('isDying')
		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ deltaTime, currentTick }) {
		const chunkIds = this.query.getChunks()

		for (const chunkId of chunkIds) {
			const lifetimes = this.getComponentData(chunkId, lifetime)
			const states = this.getComponentData(chunkId, lifecycleState)
			let wasChunkModified = false

			const activeCount = this.getIndicesFromMask(this.isActiveMaskId, chunkId, this.scratchBuffer)
			for (let j = 0; j < activeCount; j++) {
				const indexInChunk = this.scratchBuffer[j]
				const newTime = Math.max(0, lifetimes.timer[indexInChunk] - deltaTime)
				lifetimes.timer[indexInChunk] = newTime

				if (newTime <= 0) {
					// Instead of instant death, transition to DYING to trigger a death animation.
					this.clearBit(this.isActiveMaskId, chunkId, indexInChunk)
					this.setBit(this.isDyingMaskId, chunkId, indexInChunk)
					states.state[indexInChunk] = LIFECYCLE.DYING
					states.timer[indexInChunk] = DEATH_ANIMATION_DURATION
					states.duration[indexInChunk] = DEATH_ANIMATION_DURATION
					this.markEntityDirty(chunkId, indexInChunk, lifecycleState, currentTick)
					wasChunkModified = true
				}
			}
			if (wasChunkModified) {
				this.markComponentDirty(chunkId, lifecycleState, currentTick)
			}
		}
	}
}