const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager } = ecs

/**
 * The final system in the A -> B -> C dependency chain test.
 * It verifies that it runs after B and reads the correct data.
 */
export class DependencySystemC {
	static runsAfter = ['DependencySystemB'] // C must run after B.
	//static runsBefore = ['DependencySystemB'] // conflicting declaration test
	//static runsBefore = ['DependencySystemB'] // circular error expected

	static dependencies = {
		schedule: {
			reads: ['velocity'],
		},
	}

	constructor() {
		ecs.assignComponents(this, ['position', 'velocity', 'dependencyTestTag'])
		this.scheduleQuery = queryManager.getQuery({ with: [this.position, this.velocity, this.dependencyTestTag] })
	}

	schedule(chunk, context) {
		const velocities = chunk.componentData[this.velocity]
		const value = velocities.x[0]

		const expectedReadValue = 456
		if (value !== expectedReadValue) {
			console.error(
				`[DependencySystemC] FAILED! Expected to read ${expectedReadValue}, but got ${value}. 'B -> C' dependency might be broken.`,
			)
		} else {
			if (!globalThis.dependencyTestC_Passed) {
				console.log(
					`%c[DependencySystemC] SUCCESS! Read value ${value} from B. 'B -> C' is working. Full chain A->B->C is correct.`,
					'color: lightgreen',
				)
				globalThis.dependencyTestC_Passed = true
			}
		}
	}

	destroy() {
		globalThis.dependencyTestC_Passed = false
	}
}
