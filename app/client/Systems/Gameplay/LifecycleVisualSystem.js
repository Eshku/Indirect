const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { lifecycleState, viewable, isPooled } = ecs.getComponentIDs()

const { RenderLayerSystem } = ecs.getSystemIDs()

const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')

/**
 * Manages the visual state for pooled entities.
 * It reacts to changes in `LifecycleState` to hide or show sprites.
 *
 * - On `ACTIVE`: Ensures the entity's sprite is visible.
 * - On `DYING`: Hides the sprite and transitions the entity to the `POOLED` state.
 */
export class LifecycleVisualSystem {
	static runsAfter = [RenderLayerSystem] 
	static dependencies = {
		update: {
			reads: [lifecycleState, viewable],
		},
	}

	init() {
		this.lifecycleQuery = this.getQuery({
			with: [lifecycleState, viewable],
			modified: [lifecycleState], // React to data changes in lifecycleState
			added: [isPooled], // React to an entity being added to the pool
			removed: [isPooled], // React to an entity being removed from the pool
		})
	}

	update({ currentTick, lastTick }) {
		for (const chunk of this.lifecycleQuery.iter()) {
			const states = chunk.componentData[lifecycleState]
			const viewables = chunk.componentData[viewable]

			// The query now only returns entities that have changed, so we can iterate over the whole chunk.
			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				const spriteRef = viewables.spriteRef[indexInChunk]
				const sprite = engine.assetManager.getDisplayObjectByRef(spriteRef)


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
