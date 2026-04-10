const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { hitFlash, tint, isPooled } = ecs.getComponentIDs()
const { SyncTransforms, HitFlashTimerSystem } = ecs.getSystemIDs()

/**
 * Manages the "hit flash" visual effect.
 * When an entity has an active `hitFlash` component, this system reads the
 * timer and applies a corresponding red tint. The timer itself is managed
 * by HitFlashTimerSystem, which also handles resetting the tint.
 */
export class HitFlashSystem {
	static runsAfter = [HitFlashTimerSystem] // Must run after the timer is updated for the current frame.
	static runsBefore = [SyncTransforms] // Must run before the tint is rendered.

	static dependencies = {
		update: {
			reads: [hitFlash],
			writes: [tint],
		},
	}

	init() {
		// Query for entities that have the necessary components for the effect.
		this.query = this.getQuery({
			with: [hitFlash, tint],
			without: [isPooled],
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

			// This is much more efficient than iterating all entities. We only get the ones that are flashing.
			const enabledCount = this.getEnabled(chunkId, hitFlash, this.scratchBuffer)

			for (let j = 0; j < enabledCount; j++) {
				const indexInChunk = this.scratchBuffer[j]
				// 'progress' goes from 1 (at the start) down to 0 (at the end).
				const progress = flashes.timer[indexInChunk] / flashes.duration[indexInChunk]

				// Set the tint based on progress. The reset to white is now handled by HitFlashTimerSystem.
				tints.r[indexInChunk] = 1.0
				tints.g[indexInChunk] = 1.0 - progress
				tints.b[indexInChunk] = 1.0 - progress
				this.markEntityDirty(chunkId, indexInChunk, tint, currentTick)
				wasChunkModified = true
			}

			if (wasChunkModified) this.markComponentDirty(chunkId, tint, currentTick)
		}
	}
}
