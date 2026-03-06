const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()

const { position, velocity, dependencyTestTag } = ecs.getTypeIDs()
const { dependencyB } = ecs.getKernelIDs()

/**
 * A simple system that explicitly declares it must run after DependencySystemA.
 * This system will read the 'velocity' component in parallel.
 */
export class DependencySystemB {
	// No explicit control-flow needed here. Its order is determined by A and C.

	static dependencies = {
		dependencyB: {
			reads: [velocity],
			writes: [velocity],
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
			jobs.push({
				kernel: dependencyB,
				payload: chunkId,
			})
		}
		return jobs
	}

	/**
	 * On hot-swap, reset the global test flag to allow the success message to log again.
	 */
	destroy() {
		globalThis.dependencyTestB_Passed = false
	}
}
