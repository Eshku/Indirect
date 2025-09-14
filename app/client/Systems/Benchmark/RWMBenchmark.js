const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

/**
 * system for stress-testing the core ECS data processing logic.
 */
export class RWMBenchmark {
	constructor() {
		const { Position, Velocity, RWMTag } = componentManager.getTypeIDs()

		this.query = queryManager.getQuery({
			with: [Position, Velocity, RWMTag],
		})
		this.positionTypeID = Position
		this.velocityTypeID = Velocity
		this.benchmarkTagTypeID = RWMTag

		//1.2m stable
		this.entityCount = 1_200_000

		const { payload } = payloadCompiler.compileEntities({
			Position: { x: 0, y: 0 },
			Velocity: { x: 10, y: 10 },
			RWMTag: {},
		})
		this.creationPayload = payload
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
		this.commands.createEntities(this.creationPayload, this.entityCount)
		console.log(`RWMBenchmark (SoA): Finished queueing ${this.entityCount} entities for creation.`)
	}
}