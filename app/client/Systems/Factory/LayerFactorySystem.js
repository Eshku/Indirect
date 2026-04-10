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
export class LayerFactorySystem {
	// This system must run AFTER the factories have created a spriteRef.
	static runsAfter = [SpriteFactorySystem]

	init() {
		this.layerQuery = this.getQuery({
			with: [viewable, layer],
			modified: [layer],
		})

		this.stringStorage = stringInterningTable.storage
		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ deltaTime, currentTick, lastTick }) {
		const changedChunkIds = this.layerQuery.getChunks(lastTick, currentTick)

		for (let i = 0; i < changedChunkIds.length; i++) {
			const chunkId = changedChunkIds[i]

			// Narrow-phase: Get the specific indices of entities whose `layer` component was marked dirty.
			const dirtyCount = this.getDirty(chunkId, layer, lastTick, currentTick, this.scratchBuffer)

			const viewableArrays = this.getComponentData(chunkId, viewable)
			const layerArrays = this.getComponentData(chunkId, layer)

			// Iterate only over the entities that were actually marked as dirty.
			for (let j = 0; j < dirtyCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				const spriteRef = viewableArrays.spriteRef[indexInChunk]
				// The sprite is guaranteed to be initialized because this system runs after SpriteFactorySystem.
				const sprite = assetManager.getDisplayObjectByRef(spriteRef)

				const layerNameId = layerArrays.name[indexInChunk]
				const layerName = this.stringStorage[layerNameId]
				// The layer is guaranteed to exist because it's preloaded.
				//don't you dare add conditions everywhere again I swear, we WANT errors, not silent fails.
				const targetLayer = layerManager.getLayer(layerName)

				// avoid re-parenting an object that's already in the correct layer.
				if (sprite.parent !== targetLayer) {
					targetLayer.addChild(sprite)
				}
			}
		}
	}

	destroy() {}
}
