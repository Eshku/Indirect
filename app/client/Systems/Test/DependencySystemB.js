const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { position, velocity, dependencyTestTag } = ecs.getComponentIDs()
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

	/**
	 * @param {import('../../Managers/SystemManager/JobWriter.js').JobWriter} jobWriter
	 */
	schedule(jobWriter) {
		jobWriter.scheduleForEachChunk(this.query, dependencyB)
	}

	/**
	 * On hot-swap, reset the global test flag to allow the success message to log again.
	 */
	destroy() {
		globalThis.dependencyTestB_Passed = false
	}
}
