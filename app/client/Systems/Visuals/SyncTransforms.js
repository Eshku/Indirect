const { engine } = await import(`@client/Engine.js`)
const { ecs, assetManager } = engine.getManagers()

const { viewable, position, rotation, scale, tint, isPooled } = ecs.getTypeIDs()
const { SpriteFactorySystem, RenderLayerSystem } = ecs.getSystemIDs()

/**
 * Synchronizes the visual properties (position, rotation, scale) of a PIXI.Sprite
 * with the data from an entity's components. This system is highly optimized to
 * only update sprites when their corresponding component data has changed.
 */
export class SyncTransforms {
	static runsAfter = [SpriteFactorySystem, RenderLayerSystem]

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

		this.displayObjectStorage = assetManager.displayObjectStorage
		this.scratchBuffer = this.getScratchBuffer(scale)
	}

	update({ deltaTime, currentTick, lastTick, frameCounter }) {
		// --- Position Sync ---
		// No lastTick needed, this is now a non-reactive query.
		for (const chunk of this.positionQuery.iter()) {
			const viewableRefs = chunk.componentData[viewable].spriteRef
			const positionArrays = chunk.componentData[position]

			const posX = positionArrays.x
			const posY = positionArrays.y
			const displayObjectStorage = this.displayObjectStorage

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				const spriteRef = viewableRefs[indexInChunk]

				const view = displayObjectStorage[spriteRef]

				// With the new execution order, `spriteRef` is guaranteed to be valid.
				view.x = posX[indexInChunk]
				view.y = -posY[indexInChunk]
			}
		}

		// --- Rotation Sync ---
		for (const chunk of this.rotationQuery.iter()) {
			const viewableRefs = chunk.componentData[viewable].spriteRef
			const rotationArrays = chunk.componentData[rotation]

			const angle = rotationArrays.angle
			const displayObjectStorage = this.displayObjectStorage

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				const spriteRef = viewableRefs[indexInChunk]
				const view = displayObjectStorage[spriteRef]
				// With the new execution order, `spriteRef` is guaranteed to be valid.
				view.rotation = angle[indexInChunk]
			}
		}

		// --- Scale Sync ---
		// Scale is low-volatility, so we keep the reactive query and the narrow-phase check.
		for (const chunk of this.scaleQuery.iter()) {
			const viewableRefs = chunk.componentData[viewable].spriteRef
			const scaleArrays = chunk.componentData[scale]

			const scaleX = scaleArrays.x
			const scaleY = scaleArrays.y
			const displayObjectStorage = this.displayObjectStorage

			// Get the indices of entities whose `scale` component has changed.
			const changedCount = chunk.getChangedIndices(scale, lastTick, this.scratchBuffer)

			for (let i = 0; i < changedCount; i++) {
				const indexInChunk = this.scratchBuffer[i]
				const spriteRef = viewableRefs[indexInChunk]
				const view = displayObjectStorage[spriteRef]
				view.scale.set(scaleX[indexInChunk], scaleY[indexInChunk])
			}
		}

		// --- Tint Sync ---
		for (const chunk of this.tintQuery.iter()) {
			const viewableRefs = chunk.componentData[viewable].spriteRef
			const tints = chunk.componentData[tint]

			// Get the indices of entities whose `tint` component has changed.
			const changedCount = chunk.getChangedIndices(tint, lastTick, this.scratchBuffer)

			for (let i = 0; i < changedCount; i++) {
				const indexInChunk = this.scratchBuffer[i]
				const spriteRef = viewableRefs[indexInChunk]
				const view = this.displayObjectStorage[spriteRef]
				if (view) {
					const r = Math.floor(tints.r[indexInChunk] * 255)
					const g = Math.floor(tints.g[indexInChunk] * 255)
					const b = Math.floor(tints.b[indexInChunk] * 255)
					view.tint = (r << 16) | (g << 8) | b
					view.alpha = tints.a[indexInChunk]
				}
			}
		}
	}
}
