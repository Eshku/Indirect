const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { position, velocity, parallelCpuTag } = ecs.getComponentIDs()
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

		this.entityCount = 10_000

		const { payload } = this.compile({
			position: { x: 0.1, y: 0.2 },
			velocity: { x: 0.3, y: 0.4 },
			parallelCpuTag: {},
		})

		this.creationPayload = payload

		this.spawnEntities()
	}

	schedule(jobWriter, frameContext) {
		// The new signature receives a JobWriter instance.
		// This is a zero-allocation operation from the system's perspective.
		jobWriter.scheduleForEachChunk(this.query, parallelCpu)
	}

	spawnEntities() {
		this.createEntities(this.creationPayload, this.entityCount)
	}

	destroy() {
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			if (this.getChunkSize(chunkId) > 0) this.destroyEntitiesInChunk(chunkId)
		}
	}
}
