const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { Position, Velocity, CreationDestructionTag } = componentManager.getComponents()

/**
 * @fileoverview A system for stress-testing entity destruction using a high-level query-based command.
 *
 * ### Purpose
 * This benchmark measures the engine's ability to handle a massive, single-frame spike
 * of entity destructions followed by a massive spike of creations. It contrasts with
 * the other destruction benchmarks by using the `destroyEntitiesInQuery` command, which
 * is cleaner and avoids the overhead of queueing thousands of individual commands.
 *
 * ### What It Stresses
 * This system stresses the engine in a different pattern than continuous churn:
 *
 * 1.  **`CommandBuffer`**: Its ability to process a single `destroyEntitiesInQuery` command.
 *
 * 2.  **`_flushBatchDestructions`**: The new logic for iterating a query and populating
 *     the master deletion set.
 *
 * 3.  **`Archetype.compactAndRemove`**: This is still the primary bottleneck, but it's
 *     now triggered in a large, single-frame burst.
 */
export class QueryBasedDestructionBenchmarkSystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [CreationDestructionTag],
		})

		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.tagTypeID = componentManager.getComponentTypeID(CreationDestructionTag)

		// --- Configuration ---
		// This benchmark tests large, infrequent spikes of creation/destruction.

		// Goal: 20k entities destroyed in a single frame spike.
		// Current max: 20k stable
		this.poolSize = 20_000

		this.creationMap = new Map([
			[this.positionTypeID, { x: 0, y: 0 }],
			[this.velocityTypeID, { x: 0, y: 0 }],
			[this.tagTypeID, {}],
		])
	}

	init() {
		this._spawn(this.poolSize)
	}

	update(deltaTime, currentTick) {
		// Every 120 ticks (2 seconds), destroy and then respawn the entire pool.
		if (currentTick > 0 && currentTick % 120 === 0) {
			// Use a single, high-level command to destroy all matching entities.
			this.commands.destroyEntitiesInQuery(this.query)
		} else if (currentTick > 0 && currentTick % 120 === 1) {
			// On the very next frame, respawn them all.
			this._spawn(this.poolSize)
		}
	}

	_spawn(count) {
		if (count === 0) return

		// Use the hyper-optimized batch creation command.
		this.commands.createEntities(this.creationMap, count)
	}
}