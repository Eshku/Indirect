const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { Position, Velocity, RWMTag } = componentManager.getComponents()

/**
 * @fileoverview A system for stress-testing the core ECS data processing logic.
 */
export class RWMBenchmark {
	constructor() {
		this.query = queryManager.getQuery({
			with: [Position, Velocity, RWMTag],
		})
		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.benchmarkTagTypeID = componentManager.getComponentTypeID(RWMTag)

		//1.2m stable
		this.entityCount = 1_200_000

		this.creationMap = new Map([
			[this.positionTypeID, { x: 0, y: 0 }],
			[this.velocityTypeID, { x: 10, y: 10 }],
			[this.benchmarkTagTypeID, {}],
		])
	}

	init() {
		this.spawnEntities()
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const positionMarker = chunk.getDirtyMarker(this.positionTypeID, currentTick)

			const positions = chunk.componentArrays[this.positionTypeID]
			const velocities = chunk.componentArrays[this.velocityTypeID]

			const posX = positions.x
			const posY = positions.y
			const velX = velocities.x
			const velY = velocities.y

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				posX[indexInChunk] += velX[indexInChunk] * deltaTime
				posY[indexInChunk] += velY[indexInChunk] * deltaTime
				positionMarker.mark(indexInChunk)
			}
		}
	}

	spawnEntities() {
		console.log(`RWMBenchmark (SoA): Spawning ${this.entityCount} entities...`)
		this.commands.createEntities(this.creationMap, this.entityCount)
		console.log(`RWMBenchmark (SoA): Finished queueing ${this.entityCount} entities for creation.`)
	}
}