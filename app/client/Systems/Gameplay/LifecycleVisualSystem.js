const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { lifecycleState, viewable, isPooled } = ecs.getTypeIDs()

const LIFECYCLE = ecs.componentManager.getConstantsForProperty('LifecycleState', 'flags')

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
			reads: [viewable],
			writes: [lifecycleState],
		},
	}

	init() {
		this.lifecycleQuery = this.getQuery({
			with: [lifecycleState, viewable],
			react: [lifecycleState],
		})

		// Pre-compile a payload to add the isPooled tag.
		this.addIsPooledPayload = this.compile(isPooled, {}).payload

		// Pre-compile a payload to set the POOLED state.
		this.pooledStatePayload = this.compile(lifecycleState, { flags: LIFECYCLE.POOLED }).payload
	}

	update({ currentTick }) {
		for (const chunk of this.lifecycleQuery.iter()) {
			const states = chunk.componentData[lifecycleState]
			const viewables = chunk.componentData[viewable]

			for (let i = 0; i < chunk.size; i++) {
				// Only process entities whose lifecycle state has actually changed since the system last ran.
				if (!chunk.hasChanged(lifecycleState, i)) continue

				const spriteRef = viewables.spriteRef[i]
				const sprite = engine.assetManager.getDisplayObjectByRef(spriteRef)
				if (!sprite) continue
				
				const currentFlags = states.flags[i]

				if ((currentFlags & LIFECYCLE.DYING) !== 0) {
					// --- Deactivation Step ---
					sprite.visible = false
					const entityId = chunk.entities[i]
					// Transition from DYING to POOLED. This is the final step of cleanup.
					// We use commands to perform the structural change and state update.
					this.addComponent(entityId, this.addIsPooledPayload)
					this.setComponentData(entityId, this.pooledStatePayload)
				} else if ((currentFlags & LIFECYCLE.ACTIVE) !== 0) {
					// --- Activation Step ---
					// This handles both newly created entities and reactivated (un-pooled) ones.
					sprite.visible = true
				}
			}
		}
	}
}
