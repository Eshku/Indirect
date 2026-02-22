const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs, layerManager, assetManager } = engine.getManagers()
const { queryManager } = ecs
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)
const { stringInterningTable } = await import(`${PATH_INDIRECT}/StringInterningTable.js`)

/**
 * Creates visual PIXI.Graphics representations for entities that have a
 * `ShapeDescriptor` and `PlatformTag` component, and an uninitialized `Viewable` component.
 */
export class PlatformFactorySystem {
	constructor() {
		const { shapeDescriptor, platformTag, position, viewable, collider } = ecs.getTypeIDs()
		Object.assign(this, { shapeDescriptor, viewable, collider })

		this.initializationQuery = queryManager.getQuery({
			with: [shapeDescriptor, platformTag, position, viewable, collider],
			react: [shapeDescriptor],
		})

		this.gameWorldLayer = layerManager.getLayer('gameWorld')

		// Pre-compile payloads and cache the payload/mutator objects separately for cleaner access.
		const { payload: viewablePayload, mutators: viewableMutators } = payloadCompiler.compileComponent(this.viewable, { spriteRef: 0 })
		this.viewablePayload = viewablePayload
		this.viewableMutators = viewableMutators

		const { payload: colliderPayload, mutators: colliderMutators } = payloadCompiler.compileComponent(this.collider, { width: 0, height: 0 })
		this.colliderPayload = colliderPayload
		this.colliderMutators = colliderMutators
		this.stringStorage = stringInterningTable.storage
	}

	update({deltaTime, currentTick}) {
		for (const chunk of this.initializationQuery.iter()) {
			const stringStorage = this.stringStorage
			const descriptorArrays = chunk.componentData[this.shapeDescriptor]
			const viewableArrays = chunk.componentData[this.viewable]

			const shapeRefs = descriptorArrays.shape
			const widths = descriptorArrays.width
			const heights = descriptorArrays.height
			const fillColorRefs = descriptorArrays.fillColor
			const outlineColorRefs = descriptorArrays.outlineColor
			const spriteRefs = viewableArrays.spriteRef

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (chunk.hasChanged(this.shapeDescriptor, indexInChunk)) {
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

					// Use the cached mutators and payload for efficiency and readability.
					this.viewableMutators.viewable.spriteRef[0] = ref
					this.commands.setComponentData(entityId, this.viewablePayload)

					this.colliderMutators.collider.width[0] = width
					this.colliderMutators.collider.height[0] = height

					this.commands.setComponentData(entityId, this.colliderPayload)
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
	
	destroy() {}
}
