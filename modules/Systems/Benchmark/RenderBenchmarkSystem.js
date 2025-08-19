const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()

const { Position, Velocity, Speed, MovementIntent, RenderBenchmarkTag, ShapeDescriptor } =
	(await import(`${PATH_MANAGERS}/ComponentManager/ComponentManager.js`)).componentManager.getComponents()


/**
 * A system for stress-testing the rendering pipeline by spawning and manipulating a large number of visible entities.
 * On its first update, it spawns a configurable number of entities with graphics.
 * On subsequent updates, it modifies their MovementIntent and Position to make them move,
 * which in turn exercises the MovementSystem, SyncTransforms, and ViewSystem.
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

		//8k stable, cold data
		this.entityCount = 8_000

		// Pre-cache a template map. We'll clone and modify it in the loop.
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
		// Spawning is now done once during initialization, as the command buffer is ready at this stage.
		this.spawnEntities()
	}

	update(deltaTime, currentTick) {
		// Make the entities move back and forth based on the tick to generate component changes.
		const direction = Math.sin(currentTick * 0.05) > 0 ? 1 : -1

		for (const chunk of this.query.iter()) {
			const archetypeData = chunk.archetype
			// Initialize the markers once per chunk. This is cheap.
			const intentMarker = archetypeManager.getDirtyMarker(archetypeData.id, this.intentTypeID, currentTick)
			const positionMarker = archetypeManager.getDirtyMarker(archetypeData.id, this.positionTypeID, currentTick)

			// Use high-performance direct array access.
			const intents = archetypeData.componentArrays[this.intentTypeID]
			const positions = archetypeData.componentArrays[this.positionTypeID]

			for (const entityIndex of chunk) {
				// 1. Update MovementIntent to stress the MovementSystem
				intents.desiredX[entityIndex] = direction
				intentMarker.mark(entityIndex)

				// 2. Directly update Position to create more component churn and stress reactive queries.
				positions.y[entityIndex] += Math.cos(currentTick * 0.02) * 2
				positionMarker.mark(entityIndex)
			}
		}
	}

	spawnEntities() {
		if (!this.commands) return // System not fully initialized yet.
		console.log(`RenderBenchmarkSystem: Spawning ${this.entityCount} entities...`)
		for (let i = 0; i < this.entityCount; i++) {
			const x = (Math.random() - 0.5) * 2000
			const y = (Math.random() - 0.5) * 2000
			const randomColor = Math.floor(Math.random() * 16777215).toString(16)


			// Create a new map for this entity's specific data, but reuse the structure.
			const creationMap = new Map(this.creationMapTemplate)
			creationMap.set(this.positionTypeID, { x, y })
			creationMap.set(this.speedTypeID, { value: 100 + Math.random() * 50 })
			creationMap.set(this.shapeDescriptorTypeID, { shape: 'circle', color: randomColor, radius: 3, zIndex: 1 })

			this.commands.createEntity(creationMap)
		}
		console.log(`RenderBenchmarkSystem: Finished queueing ${this.entityCount} entities for creation.`)
	}
}
