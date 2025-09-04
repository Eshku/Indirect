/**
 * @fileoverview A command buffer to defer structural changes to the ECS world.
 *
 * ---
 *
 * ### Architectural Overview
 *
 * The CommandBuffer is a cornerstone of the ECS architecture, designed to solve the
 * problem of structural changes during a frame. In a traditional loop, if a system
 * adds or removes a component from an entity, it could invalidate the iterators of
 * subsequent systems, leading to bugs or crashes.
 *
 * The CommandBuffer solves this by deferring all structural changes. Instead of
 * modifying the world state immediately, systems queue "commands" (e.g., create entity,
 * add component, destroy entity). At the end of the frame, the `SystemManager` calls
 * the `flush()` method, which applies all queued changes at once in a highly
 * optimized, deterministic order.
 *
 * This ensures that all systems within a single frame operate on a stable and
 * consistent view of the world.
 *
 * ---
 *
 * ### The Flush Lifecycle
 *
 * The `flush()` method is carefully orchestrated for maximum performance and correctness.
 * It does not simply iterate and execute commands. Instead, it follows a multi-phase process:
 *
 * 1.  **Consolidation (`_consolidateCommands`)**: A single pass is made over the raw command
 *     list. This pass resolves conflicts (e.g., an `addComponent` and `removeComponent` on
 *     the same entity cancel out) and groups commands into actionable batches: deletions,
 *     modifications, and various types of creations.
 *
 * 2.  **Execution (Ordered)**: The consolidated batches are executed in a specific order:
 *     a. **Deletions (`destroyEntitiesInBatch`)**: Destroying entities first is most efficient.
 *        It shrinks archetype data arrays, making subsequent operations (like moving entities
 *        between archetypes) faster.
 *     b. **Modifications (`_flushModifications`)**: Component additions, removals, and data
 *        updates are processed next. This is heavily optimized, grouping all entities that
 *        are making the *exact same structural change* (e.g., adding ComponentA and removing
 *        ComponentB) and moving them between archetypes in a single batch operation. In-place
 *        data updates (which don't change an entity's archetype) are also batched and
 *        are extremely fast.
 *     c. **Creations (`_flushCreations`, etc.)**: New entities are created last. This allows
 *        archetypes to resize their internal arrays just *once* at the end of the frame to
 *        accommodate all new entities, rather than resizing multiple times.
 *
 * ---
 *
 * ### Which Creation Method Should I Use?
 *
 * The CommandBuffer provides several methods for creating entities, each optimized for a
 * different use case. Choosing the right one is key to performance.
 *
 * - **`commands.createEntity(componentIdMap)`**
 *   - **Use Case**: The fundamental, low-level method for creating a single, unique entity
 *     from a specific set of component data.
 *   - **Performance**: **Batched**. If multiple systems create entities with the same component
 *     structure, the `CommandBuffer` groups them and creates them all in a single, highly
 *     efficient operation.
 *
 * - **`commands.instantiate(prefabName, overrides)`**
 *   - **Use Case**: The standard method for creating a *single* entity from a data-driven prefab.
 *   - **Performance**: **Fully Batched**. If multiple `instantiate` commands for the same prefab
 *     are issued in a single frame, they are grouped and created in one highly efficient operation.
 *     It is safe to use this in a loop.
 *
 * - **`commands.instantiateBatch(prefabName, count, overrides)`**
 *   - **Use Case**: The high-performance method for creating many **identical** instances of a
 *     **data-driven** prefab (e.g., a wave of enemies, a particle burst).
 *   - **Performance**: **Highest for Prefabs**. This is the most efficient way to spawn from
 *     prefabs. It recursively creates the entire entity hierarchy in a batched,
 *     archetype-grouped manner.
 *
 * - **`commands.createEntitiesWithData(creationDataArray)`**
 *   - **Use Case**: The most flexible high-performance method for creating many **heterogeneous**
 *     entities at once. Ideal for scenarios where each new entity needs slightly different
 *     initial data (e.g., creating 100 minions, each with a different `Owner` component pointing
 *     to its newly-created parent).
 *   - **Performance**: **Highest for Flexibility**. Groups entities by their final archetype and
 *     creates each group in a single batch operation.
 */

import { CommandBufferExecutor } from './CommandBufferExecutor.js'

export class CommandBuffer {
	constructor() {
		/** @private @type {Array<object>} */
		this.commands = []

		/** @private @type {Array<Map<number, object>>} */
		this._mapPool = []
		/** @private @type {number} */
		this._poolIndex = 0

		/** @type {import('../../Managers/EntityManager/EntityManager.js').EntityManager | null} */
		this.entityManager = null
		/** @type {import('../../Managers/PrefabManager/PrefabManager.js').PrefabManager | null} */
		this.prefabManager = null
		/** @type {import('../../Managers/ComponentManager/ComponentManager.js').ComponentManager | null} */
		this.componentManager = null
		/** @type {import('../../Managers/ArchetypeManager/ArchetypeManager.js').ArchetypeManager | null} */
		this.archetypeManager = null
		/** @type {import('../../Managers/SystemManager/SystemManager.js').SystemManager | null} */
		this.systemManager = null

		/**
		 * The single, reusable executor instance. It's instantiated once in `init()`
		 * and reused for all flush and immediate-mode operations to reduce GC pressure.
		 * @private
		 * @type {CommandBufferExecutor | null}
		 */
		this.executor = null
	}

	/**
	 * Initializes the command buffer by acquiring references to necessary managers.
	 * This must be called before the command buffer can be used.
	 */
	async init() {
		this.entityManager = (await import(`${PATH_MANAGERS}/EntityManager/EntityManager.js`)).entityManager
		this.prefabManager = (await import(`${PATH_MANAGERS}/PrefabManager/PrefabManager.js`)).prefabManager
		this.componentManager = (await import(`${PATH_MANAGERS}/ComponentManager/ComponentManager.js`)).componentManager
		this.archetypeManager = (await import(`${PATH_MANAGERS}/ArchetypeManager/ArchetypeManager.js`)).archetypeManager
		this.systemManager = (await import(`${PATH_MANAGERS}/SystemManager/SystemManager.js`)).systemManager

		// Instantiate the executor once all managers are available.
		this.executor = new CommandBufferExecutor(this)
	}

	addComponent(entityId, componentTypeID, data = {}) {
		if (componentTypeID === undefined) {
			console.error(
				'CommandBuffer.addComponent: componentTypeID cannot be undefined. This usually means the component was not registered.',
				{ entityId, data }
			)
			throw new TypeError('CommandBuffer.addComponent: componentTypeID cannot be undefined.')
		}
		this.commands.push({ type: 'addComponent', entityId, componentTypeID, data })
	}

	setComponentData(entityId, componentTypeID, data) {
		if (componentTypeID === undefined) {
			console.error(
				'CommandBuffer.setComponentData: componentTypeID cannot be undefined. This usually means the component was not registered.',
				{ entityId, data }
			)
			throw new TypeError('CommandBuffer.setComponentData: componentTypeID cannot be undefined.')
		}
		this.commands.push({ type: 'setComponentData', entityId, componentTypeID, data })
	}

	removeComponent(entityId, componentTypeID) {
		this.commands.push({ type: 'removeComponent', entityId, componentTypeID })
	}

	destroyEntity(entityId) {
		this.commands.push({ type: 'destroyEntity', entityId })
	}

	/**
	 * Queues the creation of a single entity from a prefab.
	 * This method is **fully batched**. If multiple `instantiate` commands for the same prefab
	 * are issued in a frame, they will be grouped and created in a single, highly
	 * efficient operation.
	 *
	 * For creating a very large number of *identical* prefabs (e.g., particle effects),
	 * `instantiateBatch` can be slightly more performant as it has less per-entity overhead.
	 * @param {string} prefabName The name of the pre-loaded prefab.
	 * @param {object} [overrides={}] Optional additional or overriding component data.
	 */
	instantiate(prefabName, overrides = {}) {
		this.commands.push({ type: 'instantiate', prefabName, overrides })
	}

	/**
	 * Queues the high-performance, batched creation of multiple identical instances of a
	 * **data-driven** prefab.
	 * @param {string} prefabName - The name of the pre-loaded prefab.
	 * @param {number} count - The number of entities to create.
	 * @param {object} [overrides={}] - Optional or overriding component data for the ROOT entities.
	 */
	instantiateBatch(prefabName, count, overrides = {}) {
		this.commands.push({ type: 'instantiateBatch', prefabName, count, overrides })
	}

	/**
	 * Queues the creation of multiple entities, each with its own data.
	 * This is the most flexible high-performance method for bulk creation inside a system.
	 * @param {Array<object>} creationData - An array where each element is an object
	 *   representing the component data for one entity.
	 */
	createEntitiesWithData(creationData) {
		this.commands.push({ type: 'createEntitiesWithData', creationData })
	}

	/**
	 * Queues the creation of multiple **identical** entities with a given set of components.
	 * This is the highest-performance method for creating many homogeneous entities from raw data.
	 * @param {Map<number, object>} componentIdMap - A map where keys are componentTypeIDs and values are their data.
	 * @param {number} count - The number of entities to create.
	 */
	createEntities(componentIdMap, count) {
		this.commands.push({ type: 'createEntities', componentIdMap, count })
	}

	/**
	 * Queues the creation of a new entity with a given set of components. This is the fundamental,
	 * low-level method for use within systems. It is automatically batched with other
	 * `createEntity` calls that result in the same archetype.
	 * @param {Map<number, object>} [componentIdMap=new Map()] - A map where keys are componentTypeIDs and values are their data.
	 */
	createEntity(componentIdMap = new Map()) {
		// Note: The method name is kept simple for ergonomics inside systems.
		this.commands.push({ type: 'createEntity', componentIdMap })
	}

	/**
	 * Queues the creation of a new entity with a single component.
	 * This is a high-performance convenience method that uses an internal pool of Map objects.
	 * @param {number} componentTypeID - The type ID of the component to add.
	 * @param {object} [data={}] - The data for the new component.
	 */
	createEntityWithComponent(componentTypeID, data = {}) {
		const map = this.getMap()
		map.set(componentTypeID, data)
		// This pushes a command that is identical to `createEntity`, so the executor
		// doesn't need to be changed.
		this.commands.push({ type: 'createEntity', componentIdMap: map })
	}

	/**
	 * Queues the creation of a new entity in a pre-determined archetype.
	 * This is a high-performance method for when the archetype is known ahead of time,
	 * as it avoids the cost of archetype lookup during the flush.
	 * @param {number} archetypeId - The ID of the archetype to create the entity in.
	 * @param {Map<number, object>} componentIdMap - A map of component data.
	 */
	createEntityInArchetype(archetypeId, componentIdMap) {
		this.commands.push({ type: 'createEntityInArchetype', archetypeId, componentIdMap })
	}

	/**
	 * Queues the creation of a new entity with a single component in a pre-determined archetype.
	 * This is a high-performance convenience method that uses an internal pool of Map objects.
	 * @param {number} archetypeId - The ID of the archetype to create the entity in.
	 * @param {number} componentTypeID - The type ID of the component to add.
	 * @param {object} [data={}] - The data for the new component.
	 */
	createEntityInArchetypeWithComponent(archetypeId, componentTypeID, data = {}) {
		const map = this.getMap()
		map.set(componentTypeID, data)
		this.commands.push({ type: 'createEntityInArchetype', archetypeId, componentIdMap: map })
	}

	/**
	 * Queues the addition of a component to all entities matching a query.
	 * This is a high-level command that can be optimized more effectively by the engine
	 * than issuing an `addComponent` command for each individual entity.
	 * @param {import('../../Managers/QueryManager/Query.js').Query} query - The query matching entities to modify.
	 * @param {number} componentTypeID - The type ID of the component to add.
	 * @param {object} [data={}] - The data for the new component.
	 */
	addComponentToQuery(query, componentTypeID, data = {}) {
		this.commands.push({ type: 'addComponentToQuery', query, componentTypeID, data })
	}

	/**
	 * Queues the removal of a component from all entities matching a query.
	 * @param {import('../../Managers/QueryManager/Query.js').Query} query - The query matching entities to modify.
	 * @param {number} componentTypeID - The type ID of the component to remove.
	 */
	removeComponentFromQuery(query, componentTypeID) {
		this.commands.push({ type: 'removeComponentFromQuery', query, componentTypeID })
	}

	/**
	 * Queues the destruction of all entities matching a query.
	 * @param {import('../../Managers/QueryManager/Query.js').Query} query - The query matching entities to destroy.
	 */
	destroyEntitiesInQuery(query) {
		this.commands.push({ type: 'destroyEntitiesInQuery', query })
	}

	/**
	 * Queues the update of component data for all entities matching a query.
	 * This is a high-performance command for bulk data updates, ideal for scenarios
	 * like resetting all entities of a certain type. It bypasses the per-entity
	 * modification system and operates directly on whole chunks of archetype data.
	 * @param {import('../../Managers/QueryManager/Query.js').Query} query - The query matching entities to modify.
	 * @param {number} componentTypeID - The type ID of the component to update.
	 * @param {object} data - The new data to set. This will be a partial update.
	 */
	setComponentDataOnQuery(query, componentTypeID, data) {
		this.commands.push({ type: 'setComponentDataOnQuery', query, componentTypeID, data })
	}

	/**
	 * Clears all queued commands from the buffer.
	 * This is called automatically by `flush()` after all commands are processed.
	 */
	clear() {
		this.commands.length = 0 // Only clear the commands, the pool is reset in flush()
	}

	/**
	 * Executes all queued commands by delegating to the CommandBufferExecutor.
	 */
	flush() {
		if (this.commands.length === 0) return

		// Delegate to the single, reusable executor instance.
		this.executor.execute()

		// After all commands are processed, clear the buffer to ready it for the next frame.
		this.clear()
		// Reset the map pool for the next frame.
		this._resetPool()
	}

	/**
	 * Gets a reusable Map object from an internal pool.
	 * This is a key performance optimization that avoids creating new Map objects in hot loops.
	 * The pool is reset automatically after every `flush()`.
	 * @returns {Map<number, object>} A cleared Map object ready for use.
	 */
	getMap() {
		if (this._poolIndex >= this._mapPool.length) {
			// Pool is empty, create a new map.
			this._mapPool.push(new Map())
		}
		const map = this._mapPool[this._poolIndex++]
		map.clear() // Ensure the map is clean before reuse.
		return map
	}

	/**
	 * Resets the map pool index, making all maps available for reuse in the next frame.
	 * @private
	 */
	_resetPool() {
		this._poolIndex = 0
	}
}

export const commandBuffer = new CommandBuffer()
