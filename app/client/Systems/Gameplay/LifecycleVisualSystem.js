const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { lifecycleState, viewable } = ecs.getTypeIDs()

const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')

/**
 * Manages the visual state for pooled entities.
 * It reacts to changes in `LifecycleState` to hide or show sprites.
 *
 * - On `ACTIVE`: Ensures the entity's sprite is visible.
 * - On `DYING`: Hides the sprite and transitions the entity to the `POOLED` state.
 */
export class LifecycleVisualSystem {
	static dependencies = {
		update: {
			reads: [lifecycleState, viewable],
		},
	}

	init() {
		this.lifecycleQuery = this.getQuery({
			with: [lifecycleState, viewable],
			react: [lifecycleState],
		})
		this.scratchBuffer = new Uint32Array(4096) // Max chunk capacity
	}

	update({ currentTick, lastTick }) {
		for (const chunk of this.lifecycleQuery.iter()) {
			const states = chunk.componentData[lifecycleState]
			const viewables = chunk.componentData[viewable]
			const changedCount = chunk.getChangedIndices(lifecycleState, lastTick, this.scratchBuffer)

			for (let i = 0; i < changedCount; i++) {
				const indexInChunk = this.scratchBuffer[i]

				const spriteRef = viewables.spriteRef[indexInChunk]
				const sprite = engine.assetManager.getDisplayObjectByRef(spriteRef)
				if (!sprite) continue

				const flags = states.flags[indexInChunk]

				// This system is now purely visual. It hides sprites for entities that are dying or already pooled.
				if ((flags & LIFECYCLE.DYING) !== 0 || (flags & LIFECYCLE.POOLED) !== 0) {
					sprite.visible = false
				} else if ((flags & LIFECYCLE.ACTIVE) !== 0) {
					// --- Activation Step ---
					// This handles both newly created entities and reactivated (un-pooled) ones.
					sprite.visible = true
				}
			}
		}
	}
}
