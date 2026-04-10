const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { position, velocity, cpuTag } = ecs.getComponentIDs()
const { parallelCpu } = ecs.getKernelIDs()


const benchmarkConfig = {
	activeMode: 'parallel', // Options: 'singleThread', 'parallel'
	singleThreadEntityCount: 2_000,
	parallelEntityCount: 10_000,
}

/**
 * A purely CPU-bound benchmark that can be run in single-threaded or parallel mode.
 * This system performs a large number of calculations per entity, with minimal
 * memory access. It's designed to test raw CPU throughput and measure the
 * overhead and scaling of the parallel job scheduler.
 */
export class CPUBenchmark {
	static dependencies = {
		update: {
			reads: [velocity],
			writes: [position],
		},
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
			with: [position, velocity, cpuTag],
		})

		// Set entity count based on active mode
		this.entityCount =
			benchmarkConfig.activeMode === 'parallel'
				? benchmarkConfig.parallelEntityCount
				: benchmarkConfig.singleThreadEntityCount

		const { payload } = this.compile({
			position: { x: 0.1, y: 0.2 },
			velocity: { x: 0.3, y: 0.4 },
			cpuTag: {},
		})

		this.creationPayload = payload

		this.spawnEntities()
	}

	update(context) {
		if (benchmarkConfig.activeMode !== 'singleThread') {
			return
		}

		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const positions = this.getComponentData(chunkId, position)
			const velocities = this.getComponentData(chunkId, velocity)
			const chunkSize = this.getChunkSize(chunkId)

			for (let j = 0; j < chunkSize; j++) {
				// Read initial state once
				let x = positions.x[j]
				let y = velocities.y[j]

				// Perform a lot of computation.
				for (let k = 0; k < 50; k++) {
					const newX = Math.sin(x) * y - Math.cos(y) * x
					const newY = Math.cos(x) * y + Math.sin(y) * x
					x = newX
					y = newY
				}

				// Write the final result once
				positions.x[j] = x
			}
		}
	}

	schedule(jobWriter, frameContext) {
		if (benchmarkConfig.activeMode === 'parallel') {
			jobWriter.scheduleForEachChunk(this.query, parallelCpu)
		}
	}

	spawnEntities() {
		console.log(`CPUBenchmark (${benchmarkConfig.activeMode}): Spawning ${this.entityCount} entities...`)
		this.createEntities(this.creationPayload, this.entityCount)
		console.log(
			`CPUBenchmark (${benchmarkConfig.activeMode}): Finished queueing ${this.entityCount} entities for creation.`,
		)
	}

	destroy() {
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			if (this.getChunkSize(chunkId) > 0) this.destroyEntitiesInChunk(chunkId)
		}
	}
}
