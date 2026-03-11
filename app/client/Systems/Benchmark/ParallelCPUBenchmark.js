const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

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

	init() {
		this.query = this.getQuery({
			with: [position, velocity, parallelCpuTag],
		})

		// Create a large number of entities to generate many chunks (high parallelism).
		this.entityCount = 10_000

		const { payload } = this.compile({
			position: { x: 0.1, y: 0.2 },
			velocity: { x: 0.3, y: 0.4 },
			parallelCpuTag: {},
		})

		this.creationPayload = payload

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
		this.createEntities(this.creationPayload, this.entityCount)
	}

	destroy() {
		for (const chunk of this.query.iter()) {
			if (chunk.size > 0) this.destroyEntitiesInChunk(chunk)
		}
	}
}
