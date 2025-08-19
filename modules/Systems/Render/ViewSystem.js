const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, entityManager, layerManager } = theManager.getManagers()

/* const { Archetype } = await import(`${PATH_MANAGERS}/ArchetypeManager/Archetype.js`) */
const { ShapeDescriptor, Position, Viewable } = componentManager.getComponents()

/**
 * Creates visual representations for entities that have a `ShapeDescriptor` component
 * but no `Viewable` component. This is used for "asset-less" rendering, like
 * for dynamically generated projectiles.
 */
export class ViewSystem {
	constructor() {
		// This is a reactive query. It will only find entities that have gained
		// a `ShapeDescriptor` component since the last check, and that don't already have a Viewable.
		this.creationQuery = queryManager.getQuery({
			with: [ShapeDescriptor, Position], // Must have these
			without: [Viewable], // Must NOT have this
			react: [ShapeDescriptor, Position], // Reactive on ShapeDescriptor or Position component addition/change
		})

		this.viewableTypeID = componentManager.getComponentTypeID(Viewable)
		this.gameActorsLayer = layerManager.getLayer('gameActors')
		this.descriptorTypeID = componentManager.getComponentTypeID(ShapeDescriptor)
		this.positionTypeID = componentManager.getComponentTypeID(Position)
		// For direct, high-performance access to string data from 'hot' components
		this.stringInterningTable = componentManager.stringInterningTable
	}

	init() {}

	update(deltaTime, currentTick) {
		for (const chunk of this.creationQuery.iter()) {
			const archetype = chunk.archetype
			const descriptorArrays = archetype.componentArrays[this.descriptorTypeID]
			const positionArrays = archetype.componentArrays[this.positionTypeID]

			// Hoist property access out of the loop for JIT optimization.
			const shapeOffsets = descriptorArrays.shape_offset
			const shapeLengths = descriptorArrays.shape_length
			const colorOffsets = descriptorArrays.color_offset
			const colorLengths = descriptorArrays.color_length
			const radii = descriptorArrays.radius
			const widths = descriptorArrays.width
			const heights = descriptorArrays.height
			const zIndices = descriptorArrays.zIndex
			const posX = positionArrays.x
			const posY = positionArrays.y

			// The chunk iterator yields only live entities.
			for (const entityIndex of chunk) {
				if (this.creationQuery.hasChanged(archetype, entityIndex)) {
					// Reconstruct a temporary descriptor object from the raw data for the _drawShape method.
					const descriptor = {
						shape: this.stringInterningTable.get(shapeOffsets[entityIndex], shapeLengths[entityIndex]),
						color: this.stringInterningTable.get(colorOffsets[entityIndex], colorLengths[entityIndex]),
						radius: radii[entityIndex],
						width: widths[entityIndex],
						height: heights[entityIndex],
						zIndex: zIndices[entityIndex],
					}
					const entityId = archetype.entities[entityIndex]

					const graphics = new PIXI.Graphics()
					this._drawShape(graphics, descriptor)

					// Set the initial position of the graphics object to match the entity's position.
					graphics.position.set(posX[entityIndex], -posY[entityIndex])
					this.gameActorsLayer.addChild(graphics)
					graphics.zIndex = descriptor.zIndex || 0

					this.commands.addComponent(entityId, this.viewableTypeID, { view: graphics, assetName: null })
				}
			}
		}
	}

	_drawShape(graphics, descriptor) {
		const color = parseInt(descriptor.color, 16)

		switch (descriptor.shape) {
			case 'circle':
				graphics.circle(0, 0, descriptor.radius || 10).fill(color)
				break
			case 'rectangle': {
				const width = descriptor.width || 20
				const height = descriptor.height || 20
				// PIXI.Graphics rectangle draws from top-left. To center it:
				graphics.rect(-width / 2, -height / 2, width, height).fill(color)
				break
			}
			default:
				console.warn(`ViewSystem: Unknown shape type "${descriptor.shape}". Defaulting to circle.`)
				graphics.circle(0, 0, descriptor.radius || 10).fill(color)
				break
		}
	}
}
