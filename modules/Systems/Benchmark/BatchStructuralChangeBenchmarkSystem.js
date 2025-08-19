const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { ComponentA, ComponentB } = componentManager.getComponents()

/**
 * @fileoverview A system for stress-testing structural changes using high-level batch commands.
 *
 * ### Purpose
 * This benchmark measures the engine's ability to handle a high volume of structural
 * changes when the intent is expressed as a single batch operation on a query. It contrasts
 * with `StructuralChangeBenchmarkSystem`, which uses per-entity commands.
 *
 * ### What It Stresses
 * This system creates a "ping-pong" effect, moving thousands of entities back and forth
 * between two archetypes (`{ComponentA}` and `{ComponentA, ComponentB}`). This heavily tests:
 *
 * 1.  **`CommandBuffer`**: Its ability to process high-level `addComponentToQuery` and
 *     `removeComponentFromQuery` commands. This path bypasses much of the per-entity
 *     consolidation overhead.
 *
 * 2.  **`_flushBatchModifications`**: The logic for iterating query results and building
 *     the batched moves.
 *
 * 3.  **`ArchetypeManager.moveEntitiesInBatch`**: The underlying move operation, same as
 *     the individual command benchmark, but now receiving much larger, pre-grouped batches.
 *
 * This approach is expected to be significantly faster as it reduces JavaScript overhead
 * from issuing thousands of individual commands.
 */
export class BatchStructuralChangeBenchmarkSystem {
	constructor() {
		// Query for entities that have A but not B.
		this.addQuery = queryManager.getQuery({
			with: [ComponentA],
			without: [ComponentB],
		})

		// Query for entities that have both A and B.
		this.removeQuery = queryManager.getQuery({
			with: [ComponentA, ComponentB],
		})

		this.componentATypeID = componentManager.getComponentTypeID(ComponentA)
		this.componentBTypeID = componentManager.getComponentTypeID(ComponentB)

		// Batch command approach
		// Goal: 50k entities
		// Current max: 25k stable
		this.entityCount = 25_000

		// Pre-cache the component map to avoid creating objects in the loop.
		this.creationMap = new Map([[this.componentATypeID, {}]])
	}

	init() {
		// Spawn the initial pool of entities with only ComponentA.
		for (let i = 0; i < this.entityCount; i++) {
			this.commands.createEntity(this.creationMap)
		}
	}

	update(deltaTime, currentTick) {
		// This system uses the high-level batch commands, which is cleaner
		// and signals a clearer intent to the engine, allowing for deeper optimizations
		// than iterating and issuing one command per entity.

		if (currentTick % 2 === 0) {
			// Even tick: Add ComponentB to entities that don't have it.
			this.commands.addComponentToQuery(this.addQuery, this.componentBTypeID, {})
		} else {
			// Odd tick: Remove ComponentB from entities that have it.
			this.commands.removeComponentFromQuery(this.removeQuery, this.componentBTypeID)
		}
	}
}