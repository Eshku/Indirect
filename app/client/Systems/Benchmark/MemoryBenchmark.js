const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { memoryComponent, memoryTag } = ecs.getComponentIDs()
const { parallelMemory } = ecs.getKernelIDs() 


//! It is expected for memory-bound work to perform
//! worse then on single thread
//! But could be useful to measure and investigate scheduler overhead.

const benchmarkConfig = {
	activeMode: 'singleThread', // Options: 'singleThread', 'parallel'
	singleThreadEntityCount: 10_000_000,
	parallelEntityCount: 9_000_000,
}
 
/**
 * A single-threaded, purely memory-bound benchmark.
 * This system iterates over a large number of entities, performing a read
 * and then a write to the same component data location. This is designed to
 * stress memory bandwidth with minimal CPU computation. It intentionally does
 * not mark data as dirty to isolate the test to just the read/write overhead.
 */
export class MemoryBenchmark {
	static dependencies = {
		update: {
			reads: [memoryComponent],
			writes: [memoryComponent],
		},
		// Add dependencies for the parallel kernel
		parallelMemory: {
			reads: [memoryComponent],
			writes: [memoryComponent],
			context: {
				memoryComponent, // Pass component ID to the kernel
			},
		},
	}

	init() {
		this.query = this.getQuery({
			with: [memoryComponent, memoryTag],
		})

		// Set entity count based on active mode
		this.entityCount =
			benchmarkConfig.activeMode === 'parallel' ? benchmarkConfig.parallelEntityCount : benchmarkConfig.singleThreadEntityCount
		this.creationPayload = this.compile(
			{
				memoryComponent: { value: 1 },
				memoryTag: {},
			},
			{ count: this.entityCount },
		)
		this.spawnEntities()
	}

	update() {
		// Only run update logic if configured for single-threaded mode
		if (benchmarkConfig.activeMode !== 'singleThread') {
			return
		}
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const memoryComponents = this.getComponentData(chunkId, memoryComponent)
			const chunkSize = this.getChunkSize(chunkId)

			for (let j = 0; j < chunkSize; j++) {
				// Read and immediately write to the same location to test memory bandwidth.
				memoryComponents.value[j] = memoryComponents.value[j]
			}
			// do not mark anything as dirty.
		}
	}

	// New schedule method for parallel execution
	schedule(jobWriter, frameContext) {
		// Only schedule parallel jobs if configured for parallel mode
		if (benchmarkConfig.activeMode === 'parallel') {
			jobWriter.scheduleForEachChunk(this.query, parallelMemory)
		}
	}

	spawnEntities() {
		console.log(`MemoryBenchmark (${benchmarkConfig.activeMode}): Spawning ${this.entityCount} entities...`)
		this.instantiate(this.creationPayload, this.entityCount)
		console.log(`MemoryBenchmark (${benchmarkConfig.activeMode}): Finished queueing ${this.entityCount} entities for creation.`)
	}

	destroy() {
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			if (this.getChunkSize(chunkId) > 0) this.destroyEntitiesInChunk(chunkId)
		}
	}
}
