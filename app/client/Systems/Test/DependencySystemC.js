const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const { position, velocity, dependencyTestTag } = ecs.getComponentIDs()
const { dependencyC } = ecs.getKernelIDs()
const { DependencySystemB } = ecs.getSystemIDs()

/**
 * The final system in the A -> B -> C dependency chain test.
 * It verifies that it runs after B and reads the correct data.
 */
export class DependencySystemC {
	static runsAfter = DependencySystemB

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

	/**
	 * @param {import('../../Managers/SystemManager/JobWriter.js').JobWriter} jobWriter
	 */
	schedule(jobWriter) {
		jobWriter.scheduleForEachChunk(this.query, dependencyC)
	}

	destroy() {
		globalThis.dependencyTestC_Passed = false
	}
}
