const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs, assetManager } = engine.getManagers()
const { queryManager } = ecs

/**
 * Synchronizes the visual properties (position, rotation, scale) of a PIXI.Sprite
 * with the data from an entity's components. This system is highly optimized to
 * only update sprites when their corresponding component data has changed.
 */
export class SyncTransforms {
	constructor() {
		const { viewable, position, rotation, scale } = ecs.getTypeIDs()
		Object.assign(this, { viewable, position, rotation, scale })

		this.positionQuery = queryManager.getQuery({
			with: [viewable, position],
			react: [position],
		})
		this.rotationQuery = queryManager.getQuery({
			with: [viewable, rotation],
			react: [rotation],
		})
		this.scaleQuery = queryManager.getQuery({
			with: [viewable, scale],
			react: [scale],
		})

		this.displayObjectStorage = assetManager.displayObjectStorage
	}

	update(deltaTime, currentTick) {
		// --- Position Sync ---
		for (const chunk of this.positionQuery.iter()) {
			const viewableRefs = chunk.componentArrays[this.viewable].spriteRef
			const positionArrays = chunk.componentArrays[this.position]

			const posX = positionArrays.x
			const posY = positionArrays.y
			const displayObjectStorage = this.displayObjectStorage

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (this.positionQuery.hasChanged(chunk, indexInChunk)) {
					const spriteRef = viewableRefs[indexInChunk]
					if (spriteRef === 0) continue

					const view = displayObjectStorage[spriteRef]
					if (!view) continue

					view.x = posX[indexInChunk]
					view.y = -posY[indexInChunk]
				}
			}
		}

		// --- Rotation Sync ---
		for (const chunk of this.rotationQuery.iter()) {
			const viewableRefs = chunk.componentArrays[this.viewable].spriteRef
			const rotationArrays = chunk.componentArrays[this.rotation]

			const angle = rotationArrays.angle
			const displayObjectStorage = this.displayObjectStorage

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (this.rotationQuery.hasChanged(chunk, indexInChunk)) {
					const spriteRef = viewableRefs[indexInChunk]
					if (spriteRef === 0) continue

					const view = displayObjectStorage[spriteRef]
					if (!view) continue
					view.rotation = angle[indexInChunk]
				}
			}
		}

		// --- Scale Sync ---
		for (const chunk of this.scaleQuery.iter()) {
			const viewableRefs = chunk.componentArrays[this.viewable].spriteRef
			const scaleArrays = chunk.componentArrays[this.scale]

			const scaleX = scaleArrays.x
			const scaleY = scaleArrays.y
			const displayObjectStorage = this.displayObjectStorage

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (this.scaleQuery.hasChanged(chunk, indexInChunk)) {
					const spriteRef = viewableRefs[indexInChunk]
					if (spriteRef === 0) continue

					const view = displayObjectStorage[spriteRef]
					if (!view) continue
					view.scale.set(scaleX[indexInChunk], scaleY[indexInChunk])
				}
			}
		}
	}
}