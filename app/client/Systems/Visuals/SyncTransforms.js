const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, assetManager } = theManager.getManagers()

const { Viewable, Position, Rotation, Scale } = componentManager.getComponents()

/**
 * Synchronizes the visual properties (position, rotation, scale) of a PIXI.Sprite
 * with the data from an entity's components. This system is highly optimized to
 * only update sprites when their corresponding component data has changed.
 */
export class SyncTransforms {
	constructor() {
		this.positionQuery = queryManager.getQuery({
			with: [Viewable, Position],
			react: [Position],
		})
		this.rotationQuery = queryManager.getQuery({
			with: [Viewable, Rotation],
			react: [Rotation],
		})
		this.scaleQuery = queryManager.getQuery({
			with: [Viewable, Scale],
			react: [Scale],
		})

		this.viewableTypeID = componentManager.getComponentTypeID(Viewable)
		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.rotationTypeID = componentManager.getComponentTypeID(Rotation)
		this.scaleTypeID = componentManager.getComponentTypeID(Scale)
		this.displayObjectStorage = assetManager.displayObjectStorage
	}

	update(deltaTime, currentTick) {
		// --- Position Sync ---
		for (const chunk of this.positionQuery.iter()) {
			const viewableRefs = chunk.componentArrays[this.viewableTypeID].spriteRef
			const positionArrays = chunk.componentArrays[this.positionTypeID]

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
			const viewableRefs = chunk.componentArrays[this.viewableTypeID].spriteRef
			const rotationArrays = chunk.componentArrays[this.rotationTypeID]

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
			const viewableRefs = chunk.componentArrays[this.viewableTypeID].spriteRef
			const scaleArrays = chunk.componentArrays[this.scaleTypeID]

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