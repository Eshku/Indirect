const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, layerManager, assetManager } = theManager.getManagers()

const { SpriteDescriptor, Position, Viewable } = componentManager.getComponents()

/**
 * Creates visual PIXI.Sprite representations for entities that have a
 * `SpriteDescriptor` and an uninitialized `Viewable` component. This system
 * acts as an "initializer" for asset-based visuals, populating existing
 * components to avoid structural changes.
 */
export class SpriteFactorySystem {
	constructor() {
		// This query finds entities that have all the necessary components,
		// and reacts to the "trigger" SpriteDescriptor component.
		this.initializationQuery = queryManager.getQuery({
			with: [SpriteDescriptor, Position, Viewable],
			react: [SpriteDescriptor],
		})

		this.descriptorTypeID = componentManager.getComponentTypeID(SpriteDescriptor)
		this.viewableTypeID = componentManager.getComponentTypeID(Viewable)
		this.gameActorsLayer = layerManager.getLayer('gameActors')
		// For direct, high-performance access to string data from 'hot' components
		this.stringInterningTable = componentManager.stringInterningTable
	}

	init() {}

	async update(deltaTime, currentTick) {
		// This query is reactive, so it will only iterate over chunks containing entities
		// that have recently gained a SpriteDescriptor.
		for (const chunk of this.initializationQuery.iter()) {
			const archetype = chunk.archetype
			const descriptorArrays = archetype.componentArrays[this.descriptorTypeID]
			// Viewable is a "cold" component, so we get an array of its instances.
			const viewableInstances = archetype.componentArrays[this.viewableTypeID]

			// Hoist property access out of the loop for JIT optimization.
			const assetNameOffsets = descriptorArrays.assetName_offset
			const assetNameLengths = descriptorArrays.assetName_length

			for (const entityIndex of chunk) {
				// This check makes the system idempotent. If the view has already been
				// created, we skip this entity, even if the query matches it again.
				const viewable = viewableInstances[entityIndex]
				if (viewable && viewable.view) {
					continue
				}

				const entityId = archetype.entities[entityIndex]

				// Get the raw string from the interning table using the offset and length.
				const assetName = this.stringInterningTable.get(assetNameOffsets[entityIndex], assetNameLengths[entityIndex])

				const sprite = await assetManager.createSprite(assetName)

				if (sprite) {
					sprite.anchor.set(0.5)
					this.gameActorsLayer.addChild(sprite)
					// Set data on the existing Viewable component instead of adding a new one.
					this.commands.setComponentData(entityId, this.viewableTypeID, { view: sprite, assetName })
				}
			}
		}
	}
}
