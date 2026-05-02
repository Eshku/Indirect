const { engine } = await import(`@client/Engine.js`)
const { ecs, assetManager } = engine.getManagers()

const { viewable, position, rotation, scale, tint, visibility, isPooled } = ecs.getComponentIDs()
const { SpriteFactorySystem, LayerFactorySystem } = ecs.getSystemIDs()

/**
 * Synchronizes the visual properties (position, rotation, scale) of a PIXI.Sprite
 * with the data from an entity's components. This system is highly optimized to
 * only update sprites when their corresponding component data has changed.
 */
export class SyncTransforms {
	static runsAfter = [SpriteFactorySystem, LayerFactorySystem]

	init() {
		this.positionQuery = this.getQuery({
			with: [viewable, position],
			without: [isPooled],
			// react: [position], // Position is high-volatility.
		})

		this.rotationQuery = this.getQuery({
			with: [viewable, rotation],
			without: [isPooled],
			// react: [rotation], // Rotation is high-volatility.
		})

		this.scaleQuery = this.getQuery({
			with: [viewable, scale],
			modified: [scale], // Scale is low-volatility, changes are rare.
			without: [isPooled],
		})

		this.tintQuery = this.getQuery({
			with: [viewable, tint],
			without: [isPooled],
			modified: [tint],
		})

		this.visibilityQuery = this.getQuery({
			with: [viewable, visibility],
			modified: [visibility], // Broad-phase only.
		})

		this.displayObjectStorage = assetManager.displayObjectStorage
		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ deltaTime, currentTick, lastTick, frameCounter }) {
		// --- Position Sync ---
		const positionChunkIds = this.positionQuery.getChunks()
		for (let i = 0; i < positionChunkIds.length; i++) {
			const chunkId = positionChunkIds[i]
			const viewableRefs = this.getComponentData(chunkId, viewable).spriteRef
			const positionArrays = this.getComponentData(chunkId, position)

			const posX = positionArrays.x
			const posY = positionArrays.y
			const displayObjectStorage = this.displayObjectStorage
			const chunkSize = this.getChunkSize(chunkId)

			for (let indexInChunk = 0; indexInChunk < chunkSize; indexInChunk++) {
				const spriteRef = viewableRefs[indexInChunk]
				const view = displayObjectStorage[spriteRef]

				view.x = posX[indexInChunk]
				view.y = -posY[indexInChunk]
			}
		}

		// --- Rotation Sync ---
		const rotationChunkIds = this.rotationQuery.getChunks()
		for (let i = 0; i < rotationChunkIds.length; i++) {
			const chunkId = rotationChunkIds[i]
			const viewableRefs = this.getComponentData(chunkId, viewable).spriteRef
			const rotationArrays = this.getComponentData(chunkId, rotation)

			const angle = rotationArrays.angle
			const displayObjectStorage = this.displayObjectStorage
			const chunkSize = this.getChunkSize(chunkId)

			for (let indexInChunk = 0; indexInChunk < chunkSize; indexInChunk++) {
				const spriteRef = viewableRefs[indexInChunk]
				const view = displayObjectStorage[spriteRef]
				view.rotation = angle[indexInChunk]
			}
		}

		// --- Scale Sync ---
		// Scale is low-volatility, so we keep the reactive query and the narrow-phase check.
		const scaleChunkIds = this.scaleQuery.getChunks()
		for (let i = 0; i < scaleChunkIds.length; i++) {
			const chunkId = scaleChunkIds[i]
			const viewableRefs = this.getComponentData(chunkId, viewable).spriteRef
			const scaleArrays = this.getComponentData(chunkId, scale)

			const scaleX = scaleArrays.x
			const scaleY = scaleArrays.y
			const displayObjectStorage = this.displayObjectStorage

			// Get the indices of entities whose `scale` component has changed.
			const changedCount = this.getDirty(chunkId, scale, lastTick, currentTick, this.scratchBuffer)

			for (let j = 0; j < changedCount; j++) {
				const indexInChunk = this.scratchBuffer[j]
				const spriteRef = viewableRefs[indexInChunk]
				const view = displayObjectStorage[spriteRef]
				view.scale.set(scaleX[indexInChunk], scaleY[indexInChunk])
			}
		}

		// --- Tint Sync ---
		const tintChunkIds = this.tintQuery.getChunks()
		for (let i = 0; i < tintChunkIds.length; i++) {
			const chunkId = tintChunkIds[i]
			const viewableRefs = this.getComponentData(chunkId, viewable).spriteRef
			const tints = this.getComponentData(chunkId, tint)

			// Get the indices of entities whose `tint` component has changed.
			const changedCount = this.getDirty(chunkId, tint, lastTick, currentTick, this.scratchBuffer)
			for (let j = 0; j < changedCount; j++) {
				const indexInChunk = this.scratchBuffer[j]
				const spriteRef = viewableRefs[indexInChunk]
				const view = this.displayObjectStorage[spriteRef]

				const r = Math.floor(tints.r[indexInChunk] * 255)
				const g = Math.floor(tints.g[indexInChunk] * 255)
				const b = Math.floor(tints.b[indexInChunk] * 255)
				view.tint = (r << 16) | (g << 8) | b
				view.alpha = tints.a[indexInChunk]
			}
		}

		// --- Visibility Sync ---
		const visibilityChunkIds = this.visibilityQuery.getChunks(lastTick, currentTick)
		for (let i = 0; i < visibilityChunkIds.length; i++) {
			const chunkId = visibilityChunkIds[i]
			const viewableRefs = this.getComponentData(chunkId, viewable).spriteRef
			const visibilities = this.getComponentData(chunkId, visibility)
			const chunkSize = this.getChunkSize(chunkId)

			// Since this is a broad-phase only query, we iterate all entities in the dirty chunk.
			for (let indexInChunk = 0; indexInChunk < chunkSize; indexInChunk++) {
				const spriteRef = viewableRefs[indexInChunk]
				const view = this.displayObjectStorage[spriteRef]

				// `isVisible` is a u8 (0 or 1)
				view.visible = !!visibilities.isVisible[indexInChunk]
			}
		}
	}
}
