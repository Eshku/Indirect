const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, layerManager, assetManager } = theManager.getManagers()

const { ShapeDescriptor, PlatformTag, Position, Viewable, Collider } = componentManager.getComponents()

/**
 * Creates visual PIXI.Graphics representations for entities that have a
 * `ShapeDescriptor` and `PlatformTag` component, and an uninitialized `Viewable` component.
 */
export class PlatformFactorySystem {
	constructor() {
		this.initializationQuery = queryManager.getQuery({
			with: [ShapeDescriptor, PlatformTag, Position, Viewable, Collider],
			react: [ShapeDescriptor],
		})

		this.descriptorTypeID = componentManager.getComponentTypeID(ShapeDescriptor)
		this.viewableTypeID = componentManager.getComponentTypeID(Viewable)
		this.colliderTypeID = componentManager.getComponentTypeID(Collider)
		this.gameWorldLayer = layerManager.getLayer('gameWorld')
		this.stringStorage = componentManager.stringManager.storage
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.initializationQuery.iter()) {
			const stringStorage = this.stringStorage
			const descriptorArrays = chunk.componentArrays[this.descriptorTypeID]
			const viewableArrays = chunk.componentArrays[this.viewableTypeID]

			const shapeRefs = descriptorArrays.shape
			const widths = descriptorArrays.width
			const heights = descriptorArrays.height
			const fillColorRefs = descriptorArrays.fillColor
			const outlineColorRefs = descriptorArrays.outlineColor
			const spriteRefs = viewableArrays.spriteRef

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (this.initializationQuery.hasChanged(chunk, indexInChunk)) {
					if (spriteRefs[indexInChunk] !== 0) {
						continue
						// Already initialized
						// might be redundent check, as double-tap reactivity was fixed
						// archetype change should not trigger it too.
					}

					const shapeStr = stringStorage[shapeRefs[indexInChunk]]
					if (shapeStr !== 'rectangle') {
						continue
					}

					const entityId = chunk.entities[indexInChunk]
					const width = widths[indexInChunk]
					const height = heights[indexInChunk]
					const fillColorStr = stringStorage[fillColorRefs[indexInChunk]]
					const outlineColorStr = stringStorage[outlineColorRefs[indexInChunk]]

					const size = { width, height }
					const color = {
						fill: parseInt(fillColorStr, 16),
						outline: parseInt(outlineColorStr, 16),
					}

					const graphic = new PIXI.Graphics()
					this._drawFlatPlatform(graphic, size, color)
					this.gameWorldLayer.addChild(graphic)

					const ref = assetManager.acquireDisplayObjectRef(graphic)

					this.commands.setComponentData(entityId, this.viewableTypeID, { spriteRef: ref })
					this.commands.setComponentData(entityId, this.colliderTypeID, { width, height })
				}
			}
		}
	}

	_drawFlatPlatform(graphic, size, color) {
		const w = size.width
		const h = size.height
		const halfW = w / 2
		const halfH = h / 2

		graphic.rect(-halfW, -halfH, w, h).fill(color.fill).stroke({ width: 2, color: color.outline })
	}
}
