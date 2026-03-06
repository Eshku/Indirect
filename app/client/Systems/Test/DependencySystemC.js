const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { position, velocity, dependencyTestTag } = ecs.getTypeIDs()
const { dependencyC } = ecs.getKernelIDs()
const { DependencySystemB } = ecs.getSystemIDs()

/**
 * The final system in the A -> B -> C dependency chain test.
 * It verifies that it runs after B and reads the correct data.
 */
export class DependencySystemC {
	static runsAfter = [DependencySystemB]

	static dependencies = {
		dependencyC: {
			reads: [velocity],
			context: {
				velocity,
			},
		},
	}

	init() {
		this.query = this.getQuery({ with: [position, velocity, dependencyTestTag] })
	}

	schedule() {
		const jobs = []
		const chunkIds = this.query.getChunks()
		for (const chunkId of chunkIds) {
			jobs.push({ kernel: dependencyC, payload: chunkId })
		}
		return jobs
	}

	destroy() {
		globalThis.dependencyTestC_Passed = false
	}
}
