const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { hitFlash } = ecs.getComponentIDs()

/**
 * Ticks down the timer for active hitFlash effects and disables them when they expire.
 * This separates the timing logic from the visual application of the effect.
 */
export class HitFlashTimerSystem {
	static dependencies = {
		update: {
			reads: [hitFlash],
			writes: [hitFlash],
		},
	}

	init() {
		this.query = this.getQuery({
			with: [hitFlash],
		})
		this.scratchBuffer = this.getScratchBuffer(hitFlash)
	}

	update({ deltaTime }) {
		for (const chunk of this.query.iter()) {
			const flashes = chunk.componentData[hitFlash]

			// Get only the entities where the hitFlash component is currently enabled.
			const enabledCount = chunk.getEnabledIndices(hitFlash, this.scratchBuffer)

			for (let i = 0; i < enabledCount; i++) {
				const indexInChunk = this.scratchBuffer[i]

				const newTime = Math.max(0, flashes.timer[indexInChunk] - deltaTime)
				flashes.timer[indexInChunk] = newTime

				if (newTime === 0) {
					chunk.disableComponent(indexInChunk, hitFlash)
				}
			}
		}
	}
}