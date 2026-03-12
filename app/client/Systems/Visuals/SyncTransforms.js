const { engine } = await import(`@client/Engine.js`)
const { ecs, assetManager } = engine.getManagers()

const { viewable, position, rotation, scale } = ecs.getTypeIDs()

/**
 * Synchronizes the visual properties (position, rotation, scale) of a PIXI.Sprite
 * with the data from an entity's components. This system is highly optimized to
 * only update sprites when their corresponding component data has changed.
 */
export class SyncTransforms {
	init() {
		this.positionQuery = this.getQuery({
			with: [viewable, position],
			// react: [position], // REMOVED: Position is high-volatility.
		})

		this.rotationQuery = this.getQuery({
			with: [viewable, rotation],
			// react: [rotation], // REMOVED: Rotation is high-volatility.
		})

		this.scaleQuery = this.getQuery({
			with: [viewable, scale],
			react: [scale], // KEPT: Scale is low-volatility, changes are rare.
		})

		this.displayObjectStorage = assetManager.displayObjectStorage
	}

	update({ deltaTime, currentTick, lastTick }) {
		// --- Position Sync ---
		// No lastTick needed, this is now a non-reactive query.
		for (const chunk of this.positionQuery.iter()) {
			const viewableRefs = chunk.componentData[viewable].spriteRef
			const positionArrays = chunk.componentData[position]

			const posX = positionArrays.x
			const posY = positionArrays.y
			const displayObjectStorage = this.displayObjectStorage

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				// No 'if' check. We sync every entity.
				const spriteRef = viewableRefs[indexInChunk]
				if (spriteRef === 0) continue

				const view = displayObjectStorage[spriteRef]
				if (!view) continue

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
				if (spriteRef === 0) continue

				const view = displayObjectStorage[spriteRef]
				if (!view) continue
				view.rotation = angle[indexInChunk]
			}
		}

		// --- Scale Sync ---
		// Scale is low-volatility, so we keep the reactive query and the narrow-phase check.
		for (const chunk of this.scaleQuery.iter(lastTick)) {
			const viewableRefs = chunk.componentData[viewable].spriteRef
			const scaleArrays = chunk.componentData[scale]

			const scaleX = scaleArrays.x
			const scaleY = scaleArrays.y
			const displayObjectStorage = this.displayObjectStorage

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (scaleArrays.dirtyTick[indexInChunk] > lastTick) {
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
