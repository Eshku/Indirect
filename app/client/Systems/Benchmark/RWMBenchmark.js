const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager } = ecs
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)
const { position, velocity, rwmTag } = ecs.getTypeIDs()

export class RWMBenchmark {
	static dependencies = {
		update: {
			reads: [velocity],
			writes: [position],
		},
	}
	constructor() {
		this.query = queryManager.getQuery({
			with: [position, velocity, rwmTag],
		})

		//1.5m stable
		this.entityCount = 1_500_000

		const { payload } = payloadCompiler.compileEntity({
			position: { x: 0, y: 0 },
			velocity: { x: 10, y: 10 },
			rwmTag: {},
		})

		this.creationPayload = payload
	}

	init() {
		this.spawnEntities()
	}

	update({deltaTime, currentTick}) {
		for (const chunkView of this.query.iter()) {
			const positions = chunkView.componentData[position]
			const velocities = chunkView.componentData[velocity]

			for (let indexInChunk = 0; indexInChunk < chunkView.size; indexInChunk++) {
				positions.x[indexInChunk] += velocities.x[indexInChunk] * deltaTime
				positions.y[indexInChunk] += velocities.y[indexInChunk] * deltaTime
			}

			// Since we modify every entity, mark the whole component type as dirty.
			chunkView.markAllDirty(position, currentTick)
		}
	}

	spawnEntities() {
		console.log(`RWMBenchmark (SoA): Spawning ${this.entityCount} entities...`)
		this.commands.createEntities(this.creationPayload, this.entityCount)
		console.log(`RWMBenchmark (SoA): Finished queueing ${this.entityCount} entities for creation.`)
	}

	destroy() {
		console.log(`[RWMBenchmark] Cleaning up ${this.entityCount} entities...`)
		for (const chunk of this.query.iter()) {
			if (chunk.size > 0) this.commands.destroyEntitiesInChunk(chunk)
		}
	}
}
