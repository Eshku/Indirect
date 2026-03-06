const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs, assetManager } = engine.getManagers()

const { queryManager } = ecs
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)
const { stringInterningTable } = await import(`${PATH_INDIRECT}/StringInterningTable.js`)

const UNINITIALIZED_REF = 0

/**
 * Creates a PIXI.Sprite reference for entities that have a `SpriteDescriptor`
 * and an uninitialized `Viewable` component. This system's only job is to
 * create the sprite in the AssetManager and link it via the `Viewable` component.
 * It does not add the sprite to the scene.
 */
export class SpriteFactorySystem {
	constructor() {
		const { spriteDescriptor, viewable } = ecs.getTypeIDs()
		Object.assign(this, { spriteDescriptor, viewable })

		this.initializationQuery = queryManager.getQuery({
			with: [spriteDescriptor, viewable],
			react: [spriteDescriptor], // React to when a sprite is described
		})

		// Pre-compile the payload and cache the payload/mutator objects separately.
		const { payload, mutators } = payloadCompiler.compileComponent(this.viewable, { spriteRef: 0 })
		this.viewablePayload = payload
		this.viewableMutators = mutators
		this.stringStorage = stringInterningTable.storage
	}

	init() {}

	update({ deltaTime, currentTick, lastTick }) {
		for (const chunk of this.initializationQuery.iter()) {

			const descriptorArrays = chunk.componentData[this.spriteDescriptor]
			const viewableArrays = chunk.componentData[this.viewable]

			const assetNameRefs = descriptorArrays.assetName
			const spriteRefs = viewableArrays.spriteRef

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				// Only act if the descriptor was just added/changed AND the sprite hasn't been created yet.
				if (chunk.hasChanged(this.spriteDescriptor, indexInChunk) && spriteRefs[indexInChunk] === UNINITIALIZED_REF) {
					const entityId = chunk.entities[indexInChunk]
					const assetName = this.stringStorage[assetNameRefs[indexInChunk]]

					// Synchronously get a sprite reference from the asset manager.
					const newSpriteRef = assetManager.acquireSpriteRefSync(assetName, { anchor: { x: 0.5, y: 0.5 } })

					if (newSpriteRef !== null) {
						// This system's only job is to create the sprite and update the Viewable component.
						// It does NOT add it to the scene. Another system will handle that.
						this.viewableMutators.viewable.spriteRef[0] = newSpriteRef
						this.commands.setComponentData(entityId, this.viewablePayload)
					}
				}
			}
		}
	}

	destroy() {}
}
