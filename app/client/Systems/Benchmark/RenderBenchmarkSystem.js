const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { Position, Velocity, Speed, MovementIntent, RenderBenchmarkTag, ShapeDescriptor } =
	(await import(`${PATH_MANAGERS}/ComponentManager/ComponentManager.js`)).componentManager.getComponents()


/**
 * A system for stress-testing the rendering pipeline by spawning and manipulating a large number of visible entities.
 */
export class RenderBenchmarkSystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [RenderBenchmarkTag, MovementIntent, Position],
		})
		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.speedTypeID = componentManager.getComponentTypeID(Speed)
		this.intentTypeID = componentManager.getComponentTypeID(MovementIntent)
		this.benchmarkTagTypeID = componentManager.getComponentTypeID(RenderBenchmarkTag)
		this.shapeDescriptorTypeID = componentManager.getComponentTypeID(ShapeDescriptor)

		this.entityCount = 8_000

		this.creationMapTemplate = new Map([
			[this.positionTypeID, { x: 0, y: 0 }],
			[this.velocityTypeID, { x: 0, y: 0 }],
			[this.speedTypeID, { value: 100 }],
			[this.intentTypeID, { desiredX: 0, desiredY: 0 }],
			[this.shapeDescriptorTypeID, { shape: 'circle', color: 'ffffff', radius: 3, width: 0, height: 0, zIndex: 1 }],
			[this.benchmarkTagTypeID, {}],
		])
	}

	init() {
		this.spawnEntities()
	}

	update(deltaTime, currentTick) {
		const direction = Math.sin(currentTick * 0.05) > 0 ? 1 : -1

		for (const chunk of this.query.iter()) {
			const intentMarker = chunk.getDirtyMarker(this.intentTypeID, currentTick)
			const positionMarker = chunk.getDirtyMarker(this.positionTypeID, currentTick)

			const intents = chunk.componentArrays[this.intentTypeID]
			const positions = chunk.componentArrays[this.positionTypeID]

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				intents.desiredX[indexInChunk] = direction
				intentMarker.mark(indexInChunk)

				positions.y[indexInChunk] += Math.cos(currentTick * 0.02) * 2
				positionMarker.mark(indexInChunk)
			}
		}
	}

	spawnEntities() {
		if (!this.commands) return
		console.log(`RenderBenchmarkSystem: Spawning ${this.entityCount} entities...`)
		for (let i = 0; i < this.entityCount; i++) {
			const x = (Math.random() - 0.5) * 2000
			const y = (Math.random() - 0.5) * 2000
			const randomColor = Math.floor(Math.random() * 16777215).toString(16)

			const creationMap = new Map(this.creationMapTemplate)
			creationMap.set(this.positionTypeID, { x, y })
			creationMap.set(this.speedTypeID, { value: 100 + Math.random() * 50 })
			creationMap.set(this.shapeDescriptorTypeID, { shape: 'circle', color: randomColor, radius: 3, zIndex: 1 })

			this.commands.createEntity(creationMap)
		}
		console.log(`RenderBenchmarkSystem: Finished queueing ${this.entityCount} entities for creation.`)
	}
}