const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const { position, velocity, dependencyTestTag } = ecs.getComponentIDs()
const { DependencySystemB } = ecs.getSystemIDs()
const { dependencyA } = ecs.getKernelIDs()
/**
 * A simple system used to test explicit control-flow dependencies.
 * This system will write a known value to the 'velocity' component in parallel.
 */
export class DependencySystemA {
	static runsBefore = DependencySystemB

	static dependencies = {
		dependencyA: {
			writes: [velocity],
			context: {
				velocity,
			},
		},
	}

	init() {
		this.query = this.getQuery({ with: [position, velocity, dependencyTestTag] })

		const { payload } = this.compile({
			position: { x: 0, y: 0 },
			velocity: { x: 0, y: 0 }, // Initial value is 0
			dependencyTestTag: {},
		})

		this.creationPayload = payload
		// This init runs once when the system is first loaded.
		// To make the test repeatable across hot-swaps, we first destroy any entities
		// from a previous run of this test system before creating new ones.
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			this.destroyEntitiesInChunk(chunkIds[i])
		}

		// Create a batch of identical entities for the test.
		this.createEntities(this.creationPayload, 1000)
	}

	/**
	 * @param {import('../../Managers/SystemManager/JobWriter.js').JobWriter} jobWriter
	 */
	schedule(jobWriter) {
		jobWriter.scheduleForEachChunk(this.query, dependencyA)
	}
}
