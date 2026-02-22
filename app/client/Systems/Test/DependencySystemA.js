const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager, payloadCompiler } = ecs

/**
 * A simple system used to test explicit control-flow dependencies.
 * This system will write a known value to the 'velocity' component in parallel.
 */
export class DependencySystemA {
	static runsBefore = ['DependencySystemB'] // A must run before B.

	static dependencies = {
		schedule: {
			writes: ['velocity'],
		},
	}

	constructor() {
		ecs.assignComponents(this, ['position', 'velocity', 'dependencyTestTag'])
		this.scheduleQuery = queryManager.getQuery({ with: [this.position, this.velocity, this.dependencyTestTag] })

		const { payload } = payloadCompiler.compileEntity({
			position: { x: 0, y: 0 },
			velocity: { x: 0, y: 0 }, // Initial value is 0
			dependencyTestTag: {},
		})
		this.creationPayload = payload
	}

	init() {
		// This init runs once when the system is first loaded.
		// To make the test repeatable across hot-swaps, we first destroy any entities
		// from a previous run of this test system before creating new ones.
		for (const chunk of this.scheduleQuery.iter()) this.commands.destroyEntitiesInChunk(chunk)

		// Create a batch of identical entities for the test.
		this.commands.createEntities(this.creationPayload, 1000)
	}

	schedule(chunk, context) {
		const velocities = chunk.componentData[this.velocity]
		for (let i = 0; i < chunk.size; i++) {
			// Write a specific, known value.
			velocities.x[i] = 123
		}
	}
}
