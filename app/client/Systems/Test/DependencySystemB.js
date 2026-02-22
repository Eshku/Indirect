const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager } = ecs

/**
 * A simple system that explicitly declares it must run after DependencySystemA.
 * This system will read the 'velocity' component in parallel.
 */
export class DependencySystemB {
	// No explicit control-flow. Its order is determined by A and C.

	static dependencies = {
		schedule: {
			reads: ['velocity'],
			writes: ['velocity'],
		},
	}

	constructor() {
		ecs.assignComponents(this, ['position', 'velocity', 'dependencyTestTag'])
		this.scheduleQuery = queryManager.getQuery({ with: [this.position, this.velocity, this.dependencyTestTag] })
	}

	schedule(chunk, context) {
		const velocities = chunk.componentData[this.velocity]

		// We only need to check the first entity in the chunk.
		const value = velocities.x[0]

		// This check will run in a worker thread.
		// It verifies that it's reading the value written by DependencySystemA.
		const expectedReadValue = 123
		if (value !== expectedReadValue) {
			// This error will be visible in the main browser console, as worker errors are propagated.
			console.error(
				`[DependencySystemB] FAILED! Expected to read ${expectedReadValue}, but got ${value}. 'A -> B' dependency might be broken.`,
			)
		} else {
			// To avoid spamming the console, only log success once.
			if (!globalThis.dependencyTestB_Passed) {
				console.log(
					`%c[DependencySystemB] SUCCESS! Read value ${value} from A. 'A -> B' is working.`,
					'color: cyan',
				)
				globalThis.dependencyTestB_Passed = true
			}
		}

		// Now, write a new value for DependencySystemC to read.
		velocities.x[0] = 456
	}

	/**
	 * On hot-swap, reset the global test flag to allow the success message to log again.
	 */
	destroy() {
		globalThis.dependencyTestB_Passed = false
	}
}
