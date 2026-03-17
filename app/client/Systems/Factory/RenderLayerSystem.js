const { engine } = await import(`@client/Engine.js`)
const { ecs, layerManager, assetManager } = engine.getManagers()
const { stringInterningTable } = await import(`@indirect/StringInterningTable.js`)

const { viewable, layer } = ecs.getTypeIDs()

const UNINITIALIZED_REF = 0

/**
 * Ensures that entities with a Viewable sprite and a Layer component are
 * correctly placed in their designated PIXI.Container (layer).
 * This system reacts to changes in both the Viewable component (when a sprite is created)
 * and the Layer component (when an entity's layer is changed).
 */
export class RenderLayerSystem {
	init() {
		this.layerQuery = this.getQuery({
			with: [viewable, layer],
			react: [viewable, layer], // React to sprite creation OR layer changes
		})

		// Allocate scratch buffers for change detection.
		// Assuming max chunk capacity is <= 4096
		this.scratchBuffer1 = new Uint32Array(4096)
		this.scratchBuffer2 = new Uint32Array(4096)
		this.stringStorage = stringInterningTable.storage
	}

	update({ deltaTime, currentTick, lastTick }) {
		// The query iterator is primed by the SystemManager and culls chunks with no relevant changes.
		for (const chunk of this.layerQuery.iter()) {
			const viewableArrays = chunk.componentData[viewable]
			const layerArrays = chunk.componentData[layer]

			// Gather all unique indices that have changed for either component.
			const changedIndices = new Set()
			const viewableChangedCount = chunk.getChangedIndices(viewable, lastTick, this.scratchBuffer1)
			for (let i = 0; i < viewableChangedCount; i++) {
				changedIndices.add(this.scratchBuffer1[i])
			}
			const layerChangedCount = chunk.getChangedIndices(layer, lastTick, this.scratchBuffer2)
			for (let i = 0; i < layerChangedCount; i++) {
				changedIndices.add(this.scratchBuffer2[i])
			}

			if (changedIndices.size === 0) continue

			for (const indexInChunk of changedIndices) {
				const spriteRef = viewableArrays.spriteRef[indexInChunk]
				if (spriteRef === UNINITIALIZED_REF) continue

				const sprite = assetManager.getDisplayObjectByRef(spriteRef)
				if (!sprite) continue

				const layerName = this.stringStorage[layerArrays.name[indexInChunk]]
				const targetLayer = layerManager.getLayer(layerName)
				if (!targetLayer) continue

				if (sprite.parent !== targetLayer) {
					targetLayer.addChild(sprite)
				}
			}
		}
	}

	destroy() {}
}
