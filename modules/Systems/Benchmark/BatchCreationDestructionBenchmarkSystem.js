const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { Position, Velocity, CreationDestructionTag } = componentManager.getComponents()

/**
 * @fileoverview A system for stress-testing entity creation and destruction performance using batch commands.
 *
 * ### Purpose
 * This benchmark measures the engine's throughput for creating and destroying large
 * quantities of entities every frame using the most optimal `createEntitiesWithData` command.
 * It contrasts with `CreationDestructionBenchmarkSystem`, which uses per-entity commands.
 *
 * ### What It Stresses
 * This system is a best-case scenario for the engine's structural change machinery.
 * It heavily tests:
 *
 * 1.  **`CommandBuffer`**: Its ability to process a single `createEntitiesWithData` command
 *     and a set of `destroyEntity` commands. The creation path is highly optimized.
 *
 * 2.  **`_flushBatchedCreations`**: The internal command buffer logic that groups the
 *     creation data by archetype and calls the most efficient `entityManager` methods.
 *
 * 3.  **`EntityManager.createEntitiesInArchetype`**: The fastest path for creating entities,
 *     which resizes archetype arrays only once for the entire batch.
 *
 * 4.  **`Archetype.compactAndRemove`**: The destruction path remains the same and is still
 *     a major part of the workload.
 */
export class BatchCreationDestructionBenchmarkSystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [CreationDestructionTag],
		})

		// --- Use numeric IDs for the fast path ---
		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.tagTypeID = componentManager.getComponentTypeID(CreationDestructionTag)

		// --- Configuration ---

		// Goal: 100k pool size, 10k churn rate
		// Current max: 50k pool / 7k churn stable
		this.poolSize = 50_000 // Total number of entities to maintain in the pool.
		this.churnRate = 7_000 // Number of entities to create/destroy each frame.

		// --- Use a pre-cached Map with numeric type IDs ---
		// This avoids the slow string-to-ID conversion path of `createEntitiesWithData`.
		this.creationMap = new Map([
			[this.positionTypeID, { x: 0, y: 0 }],
			[this.velocityTypeID, { x: 0, y: 0 }],
			[this.tagTypeID, {}],
		])
	}

	init() {
		// Spawn the initial pool of entities.
		this._spawn(this.poolSize)
	}

	update() {
		// 1. Destroy a number of entities from the pool.
		let destroyedCount = 0
		destructionLoop: for (const chunk of this.query.iter()) {
			for (const entityIndex of chunk) {
				if (destroyedCount >= this.churnRate) {
					break destructionLoop
				}
				this.commands.destroyEntity(chunk.archetype.entities[entityIndex])
				destroyedCount++
			}
		}

		// 2. Create the same number of new entities to maintain the pool size.
		this._spawn(destroyedCount)
	}

	_spawn(count) {
		if (count === 0) return

		// --- Use the hyper-optimized batch creation command ---
		this.commands.createEntities(this.creationMap, count)
	}
}