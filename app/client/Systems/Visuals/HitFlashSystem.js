const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { hitFlash, tint, isPooled } = ecs.getTypeIDs()
const { SyncTransforms, RenderLayerSystem, SpriteFactorySystem } = ecs.getSystemIDs()

/**
 * Manages the "hit flash" visual effect.
 * When an entity has an active `hitFlash` component, this system will
 * tint it red and fade it back to its normal color over a short duration.
 */
export class HitFlashSystem {
	static runsBefore = [SyncTransforms]
	static runsAfter = [RenderLayerSystem, SpriteFactorySystem]

	static dependencies = {
		update: {
			reads: [hitFlash],
			writes: [hitFlash, tint],
		},
	}

	init() {
		// Query for entities that can flash.
		this.flashingQuery = this.getQuery({
			with: [hitFlash, tint],
			without: [isPooled],
		})
		this.scratchBuffer = this.getScratchBuffer(hitFlash)
	}

	update({ deltaTime, currentTick }) {
		for (const chunk of this.flashingQuery.iter()) {
			const flashes = chunk.componentData[hitFlash]
			const tints = chunk.componentData[tint]

			// Get only the entities where the hitFlash component is currently enabled.
			const enabledCount = chunk.getEnabledIndices(hitFlash, this.scratchBuffer)

			for (let i = 0; i < enabledCount; i++) {
				const indexInChunk = this.scratchBuffer[i]

				// Read the current duration, calculate the new one, and clamp it at 0.
				// This is a safer and clearer pattern than decrementing in place.
				const currentDuration = flashes.duration[indexInChunk]
				const newDuration = Math.max(0, currentDuration - deltaTime)
				flashes.duration[indexInChunk] = newDuration

				// 'progress' goes from 1 (at the start) down to 0 (at the end).
				const progress = newDuration / flashes.maxDuration[indexInChunk]

				// Unconditionally set the tint based on progress.
				// When progress is 0, this correctly sets the tint to white.
				tints.r[indexInChunk] = 1.0
				tints.g[indexInChunk] = 1.0 - progress
				tints.b[indexInChunk] = 1.0 - progress
				chunk.markEntityDirty(indexInChunk, tint, currentTick)

				// If the flash is over, disable the component so we don't process it next frame.
				if (newDuration === 0) {

					chunk.disableComponent(indexInChunk, hitFlash)
				}
			}
		}
	}
}
