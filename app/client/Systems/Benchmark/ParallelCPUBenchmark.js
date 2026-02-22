const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager } = ecs
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

/**
 * A purely CPU-bound parallel benchmark.
 * This system performs a large number of calculations per entity, with minimal
 * memory access, to test the raw throughput and scaling of the job scheduler
 * without being limited by memory bandwidth.
 */
export class ParallelCPUBenchmark {
	static dependencies = {
		schedule: {
			reads: ['velocity'], // Read once per entity
			writes: ['position'], // Write once per entity
		},
	}

	constructor() {
		const { position, velocity, parallelCpuTag } = ecs.getTypeIDs()
		Object.assign(this, { position, velocity, parallelCpuTag })

		this.scheduleQuery = queryManager.getQuery({
			with: [position, velocity, parallelCpuTag],
		})

		// Create a large number of entities to generate many chunks (high parallelism).
		this.entityCount = 10_000

		const { payload } = payloadCompiler.compileEntity({
			position: { x: 0.1, y: 0.2 },
			velocity: { x: 0.3, y: 0.4 },
			parallelCpuTag: {},
		})

		this.creationPayload = payload
	}

	init() {
		this.spawnEntities()
	}

	schedule(chunk, context) {
		const positions = chunk.componentData[this.position]
		const velocities = chunk.componentData[this.velocity]

		for (let i = 0; i < chunk.size; i++) {
			// Read initial state once
			let x = positions.x[i]
			let y = velocities.y[i]

			// Perform a lot of computation. 
			for (let j = 0; j < 50; j++) {
				const newX = Math.sin(x) * y - Math.cos(y) * x
				const newY = Math.cos(x) * y + Math.sin(y) * x
				x = newX
				y = newY
			}

			// Write the final result once
			positions.x[i] = x
		}
		chunk.markAllDirty(this.position, context.currentTick)
	}

	spawnEntities() {
		this.commands.createEntities(this.creationPayload, this.entityCount)
	}

	destroy() {
		for (const chunk of this.scheduleQuery.iter()) {
			if (chunk.size > 0) this.commands.destroyEntitiesInChunk(chunk)
		}
	}
}