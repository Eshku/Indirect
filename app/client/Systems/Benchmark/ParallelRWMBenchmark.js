const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager } = ecs
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

/**
 * A parallel version of the Read/Write/Modify benchmark.
 * This system performs the same work as RWMBenchmark but distributes it
 * across multiple worker threads using the `schedule` method.
 */
export class ParallelRWMBenchmark {
	static dependencies = {
		schedule: {
			reads: ['position', 'velocity'],
			writes: ['position', 'velocity'],
		},
	}

	constructor() {

		const { position, velocity, parallelRwmTag } = ecs.getTypeIDs()
		Object.assign(this, { position, velocity, parallelRwmTag })


		this.scheduleQuery = queryManager.getQuery({
			with: [position, velocity, parallelRwmTag],
		})

		this.entityCount = 2_000_000


		const { payload } = payloadCompiler.compileEntity({
			position: { x: 0, y: 0 },
			velocity: { x: 10, y: 10 },
			parallelRwmTag: {},
		})

		this.creationPayload = payload
	}

	init() {
		this.spawnEntities()
	}

	schedule(chunk, context) {
		const { deltaTime, currentTick } = context
		const positions = chunk.componentData[this.position]
		const velocities = chunk.componentData[this.velocity]

		for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
			positions.x[indexInChunk] += velocities.x[indexInChunk] * deltaTime
			positions.y[indexInChunk] += velocities.y[indexInChunk] * deltaTime
		}

		chunk.markAllDirty(this.position, currentTick)
	}

	spawnEntities() {
		console.log(`ParallelRWMBenchmark (SoA): Spawning ${this.entityCount} entities...`)
		this.commands.createEntities(this.creationPayload, this.entityCount)
		console.log(`ParallelRWMBenchmark (SoA): Finished queueing ${this.entityCount} entities for creation.`)
	}

	destroy() {
		// On hot-swap or system removal, destroy all entities created by this benchmark.
		// This is crucial for preventing entity accumulation during development.
		console.log(`[ParallelRWMBenchmark] Cleaning up ${this.entityCount} entities...`)
		for (const chunk of this.scheduleQuery.iter()) {
			if (chunk.size > 0) this.commands.destroyEntitiesInChunk(chunk)
		}
	}
}
