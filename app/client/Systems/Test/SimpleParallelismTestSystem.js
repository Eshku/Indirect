const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()

const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

const { queryManager, entityManager } = ecs

/**
 * A minimal, non-visual system to test the parallel execution model.
 *
 * This system is designed to be as simple as possible for debugging worker threads.
 * It creates a few chunks worth of entities and runs a simple data manipulation
 * task on them in the `schedule` phase. It has no visual output, which makes it
 * lightweight and ideal for adding logs to trace execution flow in workers without
 * the noise from rendering or complex game logic.
 */
export class SimpleParallelismTestSystem {
	static dependencies = {
		schedule: {
			reads: ['velocity'],
			writes: ['position'],
		},
	}

	constructor() {
		// Define a unique tag to ensure this system only operates on its own entities.
		const { position, velocity, simpleParallelismTestTag } = ecs.getTypeIDs()
		Object.assign(this, { position, velocity, simpleParallelismTestTag })

		// Query for the parallel `schedule` phase.
		this.scheduleQuery = queryManager.getQuery({
			with: [position, velocity, simpleParallelismTestTag],
		})

		// Payload for creating test entities.
		const { payload, mutators } = payloadCompiler.compileEntity({
			position: { x: 0, y: 0 },
			velocity: { x: 1, y: 0 },
			simpleParallelismTestTag: {}, // Tag for this system's entities
		})
		this.creationPayload = payload
		this.creationMutators = mutators

		// --- Entity Count Calculation ---
		// We want to create exactly enough entities to fill two chunks. This makes it
		// easy to verify that parallel jobs are correctly processing distinct chunks.

		// 1. Use the same constants as EntityManager for chunk size calculation.
		const TARGET_CHUNK_SIZE_BYTES = 16384 // 16KB
		const MIN_CHUNK_CAPACITY = 16

		// 2. Get the size of one entity in our test archetype.
		// This includes Position (16 bytes) + Velocity (16 bytes) + Entity ID (8 bytes) = 40 bytes.
		const archetypeId = this.creationPayload.archetypeId
		const bytesPerEntity = entityManager.getBytesPerEntityInArchetype(archetypeId)

		// 3. Calculate how many entities fit in one chunk and set our total count for two chunks.
		const entitiesPerChunk = Math.max(
			MIN_CHUNK_CAPACITY,
			bytesPerEntity > 0 ? Math.floor(TARGET_CHUNK_SIZE_BYTES / bytesPerEntity) : MIN_CHUNK_CAPACITY,
		)

		//amount of chunks to create
		this.entityCount = entitiesPerChunk * 25
	}

	init() {
		for (let i = 0; i < this.entityCount; i++) {
			this.creationMutators.position.x[0] = Math.random() * 800
			this.creationMutators.position.y[0] = Math.random() * 600
			this.commands.createEntity(this.creationPayload)
		}
		console.log(`[SimpleParallelismTest] Created ${this.entityCount} test entities.`)
	}

	schedule(chunk, context) {
		const { deltaTime, currentTick } = context
		const positions = chunk.componentData[this.position]
		const velocities = chunk.componentData[this.velocity]

		for (let i = 0; i < chunk.size; i++) {
			// Simple movement logic.
			positions.x[i] += velocities.x[i] * 5 // Use a fixed step for simplicity.

			// Simple boundary wrap-around.
			if (positions.x[i] > 800) {
				positions.x[i] = 0
			}
		}

		chunk.markAllDirty(this.position, currentTick)
	}

	destroy() {
		// Clean up entities created by this system on hot-swap.
		for (const chunk of this.scheduleQuery.iter()) {
			this.commands.destroyEntitiesInChunk(chunk)
		}
	}
}
