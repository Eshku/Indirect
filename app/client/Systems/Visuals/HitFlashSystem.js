const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { hitFlash, tint, isPooled } = ecs.getComponentIDs()
const { SyncTransforms, RenderLayerSystem, SpriteFactorySystem } = ecs.getSystemIDs()

/**
 * Manages the "hit flash" visual effect.
 * When an entity has an active `hitFlash` component, this system will
 * tint it red and fade it back to its normal color.
 */
export class HitFlashSystem {
	static runsBefore = [SyncTransforms]
	static runsAfter = [RenderLayerSystem, SpriteFactorySystem]

	static dependencies = {
		update: {
			reads: [hitFlash],
			writes: [tint],
		},
	}

	init() {
		// Query for entities that have the necessary components for the effect.
		// We will check the enabled state inside the loop.
		this.query = this.getQuery({
			with: [hitFlash, tint],
			without: [isPooled],
		})
	}

	update({ deltaTime, currentTick }) {
		for (const chunk of this.query.iter()) {
			const flashes = chunk.componentData[hitFlash]
			const tints = chunk.componentData[tint]

			for (let i = 0; i < chunk.size; i++) {
				// Check if the hitFlash effect is active for this entity.
				if (chunk.isComponentEnabled(i, hitFlash)) {
					// 'progress' goes from 1 (at the start) down to 0 (at the end).
					const progress = flashes.timer[i] / flashes.duration[i]

					// Set the tint based on progress.
					tints.r[i] = 1.0
					tints.g[i] = 1.0 - progress
					tints.b[i] = 1.0 - progress
					chunk.markEntityDirty(i, tint, currentTick)
				} else {
					// If the effect is not active, ensure the tint is reset to normal (white).
					// We only need to do this if it's not already white to avoid unnecessary dirty marking.
					if (tints.g[i] < 1.0 || tints.b[i] < 1.0) {
						tints.r[i] = 1.0
						tints.g[i] = 1.0
						tints.b[i] = 1.0
						chunk.markEntityDirty(i, tint, currentTick)
					}
				}
			}
		}
	}
}
