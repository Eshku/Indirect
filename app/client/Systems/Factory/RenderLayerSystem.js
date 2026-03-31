const { engine } = await import(`@client/Engine.js`)
const { ecs, layerManager, assetManager } = engine.getManagers()
const { stringInterningTable } = await import(`@indirect/StringInterningTable.js`)

const { viewable, layer } = ecs.getComponentIDs()
const { SpriteFactorySystem } = ecs.getSystemIDs()

const UNINITIALIZED_REF = 0

/**
 * Ensures that entities with a Viewable sprite and a Layer component are
 * correctly placed in their designated PIXI.Container (layer).
 * This system reacts to changes in both the Viewable component (when a sprite is created)
 * and the Layer component (when an entity's layer is changed).
 */
export class RenderLayerSystem {
	// This system must run AFTER the factories have created a spriteRef.
	static runsAfter = [SpriteFactorySystem]

	init() {
		this.layerQuery = this.getQuery({
			with: [viewable, layer],
			modified: [viewable, layer], // React to sprite creation OR layer changes
		})

		this.stringStorage = stringInterningTable.storage
	}

	update({ deltaTime, currentTick, lastTick }) {
		// The reactive query now only returns chunks containing entities whose `viewable` or `layer` has changed.
		for (const chunk of this.layerQuery.iter()) {
			const viewableArrays = chunk.componentData[viewable]
			const layerArrays = chunk.componentData[layer]

			// We can now iterate over all entities in the returned chunk, as the query itself is the filter.
			// The `getChangedIndices` and scratch buffer pattern is no longer needed here.
			// Note: This assumes the new query implementation will eventually provide a way to get
			// only the changed indices directly, but for now, iterating the whole pre-filtered chunk is correct.
			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				const spriteRef = viewableArrays.spriteRef[indexInChunk]
				if (spriteRef === UNINITIALIZED_REF) continue

				const sprite = assetManager.getDisplayObjectByRef(spriteRef)

				const layerName = this.stringStorage[layerArrays.name[indexInChunk]]
				const targetLayer = layerManager.getLayer(layerName)

				if (sprite.parent !== targetLayer) {
					targetLayer.addChild(sprite)
				}
			}
		}
	}

	destroy() {}
}
