const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, layerManager, assetManager } = theManager.getManagers()
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)
const { stringInterningTable } = await import(`${PATH_INDIRECT}/StringInterningTable.js`)

const UNINITIALIZED_REF = 0

/**
 * Creates visual PIXI.Sprite representations for entities that have a
 * `SpriteDescriptor` and an uninitialized `Viewable` component. This system
 * acts as an "initializer" for asset-based visuals, populating existing
 * components to avoid structural changes.
 */
export class SpriteFactorySystem {
	constructor() {
		const { SpriteDescriptor, Viewable } = componentManager.getTypeIDs()

		this.initializationQuery = queryManager.getQuery({
			with: [SpriteDescriptor, Viewable],
			react: [SpriteDescriptor],
		})

		this.descriptorTypeID = SpriteDescriptor
		this.viewableTypeID = Viewable
		this.gameActorsLayer = layerManager.getLayer('gameActors')

		// Pre-compile the payload and cache the payload/mutator objects separately.
		const { payload, mutators } = payloadCompiler.compileComponent(this.viewableTypeID, { spriteRef: 0 })
		this.viewablePayload = payload
		this.viewableMutators = mutators
		this.stringStorage = stringInterningTable.storage
	}

	init() {}

	update(deltaTime, currentTick, lastTick) {
		for (const chunk of this.initializationQuery.iter()) {
			const descriptorArrays = chunk.componentArrays[this.descriptorTypeID]
			const viewableArrays = chunk.componentArrays[this.viewableTypeID]

			const assetNameRefs = descriptorArrays.assetName
			const spriteRefs = viewableArrays.spriteRef
			const stringStorage = this.stringStorage

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (this.initializationQuery.hasChanged(chunk, indexInChunk)) {

					if (spriteRefs[indexInChunk] !== UNINITIALIZED_REF) {

						continue
						// Already initialized
						// might be redundent check, as double-tap reactivity was fixed
						// archetype change should not trigger it too.
					}


					const entityId = chunk.entities[indexInChunk]
					const assetName = stringStorage[assetNameRefs[indexInChunk]]
					const spriteRef = assetManager.acquireSpriteRefSync(assetName, { anchor: { x: 0.5, y: 0.5 } })

					if (spriteRef !== null) {
						const sprite = assetManager.getDisplayObjectByRef(spriteRef)
						if (sprite) this.gameActorsLayer.addChild(sprite)

						// Use the cached mutator and payload for efficiency and readability.
						this.viewableMutators.Viewable.spriteRef[0] = spriteRef
						this.commands.setComponentData(entityId, this.viewablePayload)
					}
				}
			}
		}
	}
}
