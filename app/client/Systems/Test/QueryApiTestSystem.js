const { engine } = await import(`@client/Engine.js`)
const { ecs, componentManager } = engine.getManagers()

const { position, queryTestTag } = ecs.getComponentIDs()
const { queryApiTestKernel } = ecs.getKernelIDs()

/**
 * A test system to validate the new Query API patterns, starting with
 * direct, non-generator-based chunk access.
 */
export class QueryApiTestSystem {
	static dependencies = {
		queryApiTestKernel: {
			// This kernel reads and writes position data.
			reads: [position],
			writes: [position],
			context: {
				position, // Pass the component ID to the kernel.
			},
		},
	}

	init() {
		this.query = this.getQuery({
			with: [position, queryTestTag],
		})

		// Create some entities to iterate over
		for (let i = 0; i < 10; i++) {
			const { payload } = this.compile({
				position: { x: i * 10, y: i * 5 },
				queryTestTag: {},
			})

			this.createEntity(payload)
		}

		// Flush to ensure entities are created before the first update.
		this.flush()
	}

	update({ currentTick }) {
		// The logic from the update loop is now being moved to the parallel kernel.
		// We can leave this empty or use it for main-thread-only logic if needed.
		// For this test, we will rely on the `schedule` method.
	}

	schedule(jobWriter) {
		jobWriter.scheduleForEachChunk(this.query, queryApiTestKernel)
	}
}
