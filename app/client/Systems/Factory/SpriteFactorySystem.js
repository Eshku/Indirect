const { engine } = await import(`@client/Engine.js`)
const { ecs, assetManager } = engine.getManagers()

const { stringInterningTable } = await import(`@indirect/StringInterningTable.js`)

const { spriteDescriptor, viewable } = ecs.getComponentIDs()

const UNINITIALIZED_REF = 0

/**
 * Creates a PIXI.Sprite reference for entities that have a `SpriteDescriptor`
 * and an uninitialized `Viewable` component. This system's only job is to
 * create the sprite in the AssetManager and link it via the `Viewable` component.
 * It does not add the sprite to the scene.
 */
export class SpriteFactorySystem {
	init() {
		this.initializationQuery = this.getQuery({
			with: [spriteDescriptor, viewable],
			// React when an entity GAINS a spriteDescriptor, either on creation or via addComponent.
			added: [spriteDescriptor],
		})

		this.stringStorage = stringInterningTable.storage
	}

	update({ deltaTime, currentTick, lastTick }) {
		// The query now only returns chunks that received entities with a new spriteDescriptor.
		for (const chunk of this.initializationQuery.iter()) {
			const descriptorArrays = chunk.componentData[spriteDescriptor]
			const viewableArrays = chunk.componentData[viewable]

			// Since the query is now precise ('added'), we can iterate over all entities in the returned chunk.
			// The narrow-phase check is no longer needed.
			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				// Only act if the sprite hasn't been created yet.
				if (viewableArrays.spriteRef[indexInChunk] === UNINITIALIZED_REF) {
					const assetName = this.stringStorage[descriptorArrays.assetName[indexInChunk]]

					// Synchronously get a sprite reference from the asset manager.
					const newSpriteRef = assetManager.acquireSpriteRefSync(assetName, { anchor: { x: 0.5, y: 0.5 } })

					// Direct Write: Update the component data in-place.
					viewableArrays.spriteRef[indexInChunk] = newSpriteRef
					// Mark Dirty: Immediately notify the engine of the change for the current tick.
					chunk.markEntityDirty(indexInChunk, viewable, currentTick)
				}
			}
		}
	}

	destroy() {}
}
