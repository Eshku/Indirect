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
			// React when `spriteDescriptor` is marked dirty. This happens automatically
			// on entity creation because it's a trackable component.
			modified: [spriteDescriptor],
		})

		this.stringStorage = stringInterningTable.storage
		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ deltaTime, currentTick, lastTick }) {
		// Broad-phase: Get all chunks where `spriteDescriptor` was modified.
		const changedChunkIds = this.initializationQuery.getChunks(lastTick, currentTick)

		for (let i = 0; i < changedChunkIds.length; i++) {
			const chunkId = changedChunkIds[i]
			// Narrow-phase: Get the specific indices of entities whose `spriteDescriptor` was marked dirty.
			const dirtyCount = this.getDirty(chunkId, spriteDescriptor, lastTick, currentTick, this.scratchBuffer)

			const descriptorArrays = this.getComponentData(chunkId, spriteDescriptor)
			const viewableArrays = this.getComponentData(chunkId, viewable)

			let wasChunkModified = false

			//! API limitation hit, can only mask dirty as modified
			//! could implement different mask helpers to mirror query reactivity.
			//todo yay another sidequest.

			// Iterate only over the entities that were actually marked as dirty.
			for (let j = 0; j < dirtyCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				// Only act if the sprite hasn't been created yet. This prevents re-creating
				// a sprite if the component is marked dirty for another reason, and ensures
				// we only act once.
				if (viewableArrays.spriteRef[indexInChunk] === UNINITIALIZED_REF) {
					const assetName = this.stringStorage[descriptorArrays.assetName[indexInChunk]]

					// Synchronously get a sprite reference from the asset manager.
					const newSpriteRef = assetManager.acquireSpriteRefSync(assetName, { anchor: { x: 0.5, y: 0.5 } })
					//all sprites are pre-loaded.

					viewableArrays.spriteRef[indexInChunk] = newSpriteRef
					// Mark this specific entity's `viewable` component as dirty again.
					// This is crucial for downstream systems like LayerFactorySystem to react
					// to the fact that a sprite has just been assigned.
					this.markEntityDirty(chunkId, indexInChunk, viewable, currentTick)
					wasChunkModified = true
				}
			}
			// If we modified any `viewable` components in this chunk, we must perform a
			// broad-phase mark so that other reactive systems see the change.
			if (wasChunkModified) {
				this.markComponentDirty(chunkId, viewable, currentTick)
			}
		}
	}

	destroy() {}
}
