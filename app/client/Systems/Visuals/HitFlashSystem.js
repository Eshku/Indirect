const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { hitFlash, tint } = ecs.getComponentIDs()
const { SyncTransforms } = ecs.getSystemIDs()

/**
 * A self-contained system that manages the "hit flash" visual effect.
 * When an entity's `hitFlash` component is enabled (typically by `DamageSystem`),
 * this system takes over. It is responsible for the entire lifecycle of the effect:
 * 1. Ticking down the `hitFlash.timer`.
 * 2. Applying a red tint based on the timer's progress.
 * 3. Resetting the tint to white and disabling the `hitFlash` component upon completion.
 */
export class HitFlashSystem {
	static runsBefore = [SyncTransforms] // Must run before the tint is rendered.

	static dependencies = {
		update: {
			reads: [hitFlash], // Reads timer and duration.
			writes: [tint],    // Writes to tint for the effect and the reset.
		},
	}

	init() {
		// Query for entities that have the necessary components for the effect.
		this.query = this.getQuery({
			with: [hitFlash, tint],
		})
		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ deltaTime, currentTick }) {
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const flashes = this.getComponentData(chunkId, hitFlash)
			const tints = this.getComponentData(chunkId, tint)
			let wasChunkModified = false

			// Get only the entities where the hitFlash component is currently enabled.
			const enabledCount = this.getEnabled(chunkId, hitFlash, this.scratchBuffer)

			for (let j = 0; j < enabledCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				// 1. Tick down the timer.
				const newTime = Math.max(0, flashes.timer[indexInChunk] - deltaTime)
				flashes.timer[indexInChunk] = newTime

				if (newTime <= 0) {
					// 2. Effect has expired. Reset tint and disable the component.
					this.disableComponent(chunkId, indexInChunk, hitFlash)

					// Only reset if it's not already white to avoid redundant writes.
					if (tints.g[indexInChunk] < 1.0 || tints.b[indexInChunk] < 1.0) {
						tints.r[indexInChunk] = 1.0
						tints.g[indexInChunk] = 1.0
						tints.b[indexInChunk] = 1.0
						this.markEntityDirty(chunkId, indexInChunk, tint, currentTick)
						wasChunkModified = true
					}
				} else {
					// 3. Effect is active. Apply the red tint.
					// 'progress' goes from 1 (at the start) down to 0 (at the end).
					const progress = newTime / flashes.duration[indexInChunk]
					tints.r[indexInChunk] = 1.0
					tints.g[indexInChunk] = 1.0 - progress
					tints.b[indexInChunk] = 1.0 - progress
					this.markEntityDirty(chunkId, indexInChunk, tint, currentTick)
					wasChunkModified = true
				}
			}

			if (wasChunkModified) this.markComponentDirty(chunkId, tint, currentTick)
		}
	}
}
