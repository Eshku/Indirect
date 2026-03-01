const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs, layerManager, assetManager } = engine.getManagers()
const { queryManager } = ecs
const { stringInterningTable } = await import(`${PATH_INDIRECT}/StringInterningTable.js`)

const UNINITIALIZED_REF = 0

/**
 * Ensures that entities with a Viewable sprite and a Layer component are
 * correctly placed in their designated PIXI.Container (layer).
 * This system reacts to changes in both the Viewable component (when a sprite is created)
 * and the Layer component (when an entity's layer is changed).
 */
export class RenderLayerSystem {
	constructor() {
		const { viewable, layer } = ecs.getTypeIDs()
		Object.assign(this, { viewable, layer })

		this.layerQuery = queryManager.getQuery({
			with: [viewable, layer],
			react: [viewable, layer], // React to sprite creation OR layer changes
		})

		this.stringStorage = stringInterningTable.storage
	}

	init() {}

	update({ deltaTime, currentTick, lastTick }) {
		for (const chunk of this.layerQuery.iter()) {
			const viewableArrays = chunk.componentData[this.viewable]
			const layerArrays = chunk.componentData[this.layer]

			for (let i = 0; i < chunk.size; i++) {
				// We only need to act if one of the components we care about has changed.
				if (chunk.hasChanged(this.viewable, i) || chunk.hasChanged(this.layer, i)) {
					const spriteRef = viewableArrays.spriteRef[i]

					// If spriteRef is 0, the sprite hasn't been created yet. Skip.
					if (spriteRef === UNINITIALIZED_REF) continue

					const sprite = assetManager.getDisplayObjectByRef(spriteRef)
					if (!sprite) continue // Should not happen if ref is valid, but good practice.

					const layerName = this.stringStorage[layerArrays.name[i]]
					const targetLayer = layerManager.getLayer(layerName)

					if (!targetLayer) continue

					// Only move the sprite if it's not already in the correct layer.
					if (sprite.parent !== targetLayer) {
						// PIXI's addChild automatically removes the object from its previous parent.
						targetLayer.addChild(sprite)
					}
				}
			}
		}
	}

	destroy() {}
}