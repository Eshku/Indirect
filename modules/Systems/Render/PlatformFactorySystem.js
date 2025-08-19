const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, layerManager } = theManager.getManagers()

const { ShapeDescriptor, PlatformTag, Position, Viewable, Collider } = componentManager.getComponents()

/**
 * Creates visual PIXI.Graphics representations for entities that have a
 * `ShapeDescriptor` and `PlatformTag` component, and an uninitialized `Viewable` component.
 * This system acts as an "initializer" for procedurally drawn 2D platforms,
 * populating existing components rather than adding new ones to avoid expensive
 * structural changes.
 */
export class PlatformFactorySystem {
	constructor() {
		// This query finds entities that have all the necessary components,
		// and reacts to the "trigger" ShapeDescriptor component on entities with a PlatformTag.
		this.initializationQuery = queryManager.getQuery({
			with: [ShapeDescriptor, PlatformTag, Position, Viewable, Collider],
			react: [ShapeDescriptor],
		})

		this.descriptorTypeID = componentManager.getComponentTypeID(ShapeDescriptor)
		this.viewableTypeID = componentManager.getComponentTypeID(Viewable)
		this.colliderTypeID = componentManager.getComponentTypeID(Collider)
		this.gameWorldLayer = layerManager.getLayer('gameWorld')
		this.stringInterningTable = componentManager.stringInterningTable
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.initializationQuery.iter()) {
			const archetype = chunk.archetype
			// This is a "hot" component, so we access its data via TypedArrays.
			const descriptorArrays = archetype.componentArrays[this.descriptorTypeID]
			// Viewable is a "cold" component, so we get an array of its instances.
			const viewableInstances = archetype.componentArrays[this.viewableTypeID]

			// Hoist property access out of the loop for JIT optimization.
			const shapeOffsets = descriptorArrays.shape_offset
			const shapeLengths = descriptorArrays.shape_length
			const widths = descriptorArrays.width
			const heights = descriptorArrays.height
			const fillColorOffsets = descriptorArrays.fillColor_offset
			const fillColorLengths = descriptorArrays.fillColor_length
			const outlineColorOffsets = descriptorArrays.outlineColor_offset
			const outlineColorLengths = descriptorArrays.outlineColor_length

			for (const entityIndex of chunk) {
				// This check makes the system idempotent. If the view has already been
				// created, we skip this entity, even if the query matches it again.
				const viewable = viewableInstances[entityIndex]
				if (viewable && viewable.view) {
					continue
				}

				const shapeStr = this.stringInterningTable.get(shapeOffsets[entityIndex], shapeLengths[entityIndex])
				// This system only handles rectangular platforms. Other shapes might be handled by other systems.
				if (shapeStr !== 'rectangle') {
					continue
				}

				const entityId = archetype.entities[entityIndex]

				const width = widths[entityIndex]
				const height = heights[entityIndex]
				const fillColorStr = this.stringInterningTable.get(fillColorOffsets[entityIndex], fillColorLengths[entityIndex])
				const outlineColorStr = this.stringInterningTable.get(
					outlineColorOffsets[entityIndex],
					outlineColorLengths[entityIndex]
				)

				const size = { width, height }
				const color = {
					fill: parseInt(fillColorStr, 16),
					outline: parseInt(outlineColorStr, 16),
				}

				const graphic = new PIXI.Graphics()
				this._drawFlatPlatform(graphic, size, color)

				this.gameWorldLayer.addChild(graphic)

				// Set data on existing components instead of adding new ones. No structural change!
				this.commands.setComponentData(entityId, this.viewableTypeID, { view: graphic, assetName: null })
				this.commands.setComponentData(entityId, this.colliderTypeID, { width, height })
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