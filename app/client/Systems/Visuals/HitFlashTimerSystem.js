const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { hitFlash, tint } = ecs.getComponentIDs()

/**
 * Ticks down the timer for active hitFlash effects and disables them when they expire.
 * It is also responsible for resetting the entity's tint to normal upon expiration.
 */
export class HitFlashTimerSystem {
	static dependencies = {
		update: {
			reads: [hitFlash, tint], // Read tint to avoid resetting it if already normal.
			writes: [hitFlash, tint], // Now also writes to tint to reset it.
		},
	}

	init() {
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
			let wasTintChunkModified = false

			// Get only the entities where the hitFlash component is currently enabled.
			const enabledCount = this.getEnabled(chunkId, hitFlash, this.scratchBuffer)

			for (let j = 0; j < enabledCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				const newTime = Math.max(0, flashes.timer[indexInChunk] - deltaTime)
				flashes.timer[indexInChunk] = newTime

				if (newTime <= 0) {
					// The effect has expired. Disable the component.
					this.disableComponent(chunkId, indexInChunk, hitFlash)

					// Also, reset the tint to white as part of the cleanup.
					// We check if it's already white to avoid redundant writes and dirty marking.
					if (tints.g[indexInChunk] < 1.0 || tints.b[indexInChunk] < 1.0) {
						tints.r[indexInChunk] = 1.0
						tints.g[indexInChunk] = 1.0
						tints.b[indexInChunk] = 1.0
						this.markEntityDirty(chunkId, indexInChunk, tint, currentTick)
						wasTintChunkModified = true
					}
				}
			}

			if (wasTintChunkModified) {
				this.markComponentDirty(chunkId, tint, currentTick)
			}
		}
	}
}
