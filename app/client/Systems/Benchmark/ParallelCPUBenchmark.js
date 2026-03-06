const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager } = ecs
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

const { position, velocity, parallelCpuTag } = ecs.getTypeIDs()
const { parallelCpu } = ecs.getKernelIDs()
/**
 * A purely CPU-bound parallel benchmark.
 * This system performs a large number of calculations per entity, with minimal
 * memory access, to test the raw throughput and scaling of the job scheduler
 * without being limited by memory bandwidth.
 */
export class ParallelCPUBenchmark {
	static dependencies = {
		parallelCpu: {
			reads: [velocity],
			writes: [position],
			context: {
				position,
				velocity,
			},
		},
	}

	constructor() {
		this.query = queryManager.getQuery({
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

	schedule() {
		const jobs = []
		const chunkIds = this.query.getChunks()

		for (const chunkId of chunkIds) {
			jobs.push({
				kernel: parallelCpu,
				payload: chunkId,
			})
		}
		return jobs
	}

	spawnEntities() {
		this.commands.createEntities(this.creationPayload, this.entityCount)
	}

	destroy() {
		for (const chunk of this.query.iter()) {
			if (chunk.size > 0) this.commands.destroyEntitiesInChunk(chunk)
		}
	}
}
