const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()

const { memoryComponent, memoryTag } = ecs.getTypeIDs()

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
	}

	init() {
		this.query = this.getQuery({
			with: [memoryComponent, memoryTag],
		})

		// Would heavily depend on RAM.
		this.entityCount = 8_000_000

		const { payload } = this.compileEntity({
			memoryComponent: { value: 1 },
			memoryTag: {},
		})

		this.creationPayload = payload

		this.spawnEntities()
	}

	update() {
		for (const chunkView of this.query.iter()) {
			const memoryComponents = chunkView.componentData[memoryComponent]

			for (let indexInChunk = 0; indexInChunk < chunkView.size; indexInChunk++) {
				// Read and immediately write to the same location to test memory bandwidth.
				memoryComponents.value[indexInChunk] = memoryComponents.value[indexInChunk]
			}
			// Per the test requirements, we do not mark anything as dirty.
		}
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