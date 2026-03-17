const { engine } = await import(`@client/Engine.js`)
const { ecs, assetManager } = engine.getManagers()

const { stringInterningTable } = await import(`@indirect/StringInterningTable.js`)

const { spriteDescriptor, viewable } = ecs.getTypeIDs()

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
			react: [spriteDescriptor], // React to when a sprite descriptor is added or changed
		})

		// Pre-compile the payload and cache the payload/mutator objects separately.
		// The 'viewable' component must have `tracked: true` in its schema for this to work.
		const { payload } = this.compile(viewable, { spriteRef: 0 })
		this.viewablePayload = payload
		this.stringStorage = stringInterningTable.storage
		this.scratchBuffer = new Uint32Array(4096) // Max chunk capacity
	}

	update({ deltaTime, currentTick, lastTick }) {
		// The query iterator is primed by the SystemManager and culls chunks with no relevant changes.
		for (const chunk of this.initializationQuery.iter()) {
			const descriptorArrays = chunk.componentData[spriteDescriptor]
			const viewableArrays = chunk.componentData[viewable]

			// Get the indices of entities whose SpriteDescriptor has changed since the last run.
			const changedCount = chunk.getChangedIndices(spriteDescriptor, lastTick, this.scratchBuffer)

			for (let i = 0; i < changedCount; i++) {
				const indexInChunk = this.scratchBuffer[i]

				// Only act if the sprite hasn't been created yet.
				if (viewableArrays.spriteRef[indexInChunk] === UNINITIALIZED_REF) {
					const entityId = chunk.entities[indexInChunk]
					const assetName = this.stringStorage[descriptorArrays.assetName[indexInChunk]]

					// Synchronously get a sprite reference from the asset manager.
					const newSpriteRef = assetManager.acquireSpriteRefSync(assetName, { anchor: { x: 0.5, y: 0.5 } })

					if (newSpriteRef !== null) {
						// We must compile a new payload here because the payload is just a buffer.
						// We cannot mutate the shared `this.viewablePayload` as it would affect all entities in the loop.
						const { payload: newPayload } = this.compile(viewable, { spriteRef: newSpriteRef })
						this.setComponentData(entityId, newPayload)
					}
				}
			}
		}
	}

	destroy() {}
}
