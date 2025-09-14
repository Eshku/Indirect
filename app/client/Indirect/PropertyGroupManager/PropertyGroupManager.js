//! Currently tied only to prefab.id
//! could support other relations later on.
//! or cancel whole thing altogether and go for traditional shared component data
//! Or just go for basic indirection


//! this approach introduces entity creation overhead and .addComponent overhead.
//! But this does not have memory fragmentation issue other approaches have (like shared component data or tags)

//! Any alternative approach would need to solve
//! Data storage for X properties of components for all entities with specific component property of same value.

/**
 * Manages "instance-shared" component data.
 *
 * ---
 * # Architectural Pattern: Key-Based Shared Data
 * ---
 *
 * ## 1. Purpose: Group Mutation and Data De-duplication
 *
 * This manager solves two problems:
 *
 * 1.  **Efficient Group Mutation:** It allows a system to modify a single block of data
 *     and have that change instantly affect all entities of a specific prefab type.
 *     For example, a buff can change the `Damage.base` for all "Fireball" projectiles
 *     with a single write operation (O(1)), instead of iterating through thousands of
 *     entities (O(N)).
 *
 * 2.  **Data De-duplication:** It stores data that is identical for all instances of a
 *     prefab only once, saving memory.
 *
 * ## 2. How It Works: Pointer-on-Chunk, Data-off-Chunk (Model B)
 *
 * - **Schema Flag:** Components with properties flagged as `shared: true` in their schema
 *   participate in this system.
 *
 * - **Storage:**
 *   - **`sharedGroups` Array:** This array stores the actual shared data objects. Each index in this array is a `sharedGroupId`.
 *     `sharedGroups: Array<{ [componentTypeId]: { ...sharedData } }>`
 *   - **`prefabIdToSharedGroupId` Map:** This map links a `prefabId` to its corresponding `sharedGroupId`.
 *     `prefabIdToSharedGroupId: Map<prefabId, sharedGroupId>`
 *
 * - **Entity Storage:** Instead of storing the `Prefab.id` directly on the chunk as a special case,
 *   any component that has `shared: true` properties will have a single `sharedGroupId` (`u32`)
 *   allocated in its chunk data. This `sharedGroupId` acts as a pointer to the actual shared data.
 *   The `Prefab.id` itself is now just another `shared: true` property within the shared data group.
 *
 *   `Entity.chunk.componentArrays[ComponentTypeID].sharedGroupId[indexInChunk]`
 *
 * - **Keying:** While the internal storage uses `sharedGroupId`s, the primary way to *create* or *find*
 *   a shared group is still via the `Prefab.id`. This manager is specifically designed for prefab-based
 *   shared data.
 *
 * - **Entity Creation:** When an entity is created from a prefab, the `ComponentManager`
 *   separates the `shared: true` properties from the per-entity properties. It then
 *   calls `instanceGroupManager.getOrCreateGroup()` with the `prefabId` and the
 *   initial shared data. This creates the shared data block for that prefab.
 *
 * - **Dynamic Component Addition:** If a component with shared properties is added to an
 *   existing entity (that has a `Prefab.id`), the engine should call `addSharedDataToGroup()`
 *   to merge the new shared data into the prefab's existing group. This ensures that
 *   the change is correctly applied to the shared "template" for that prefab type.
 *
 * - **Data Access:**
 *   - **Systems (Hot Path):** For maximum performance, systems should access the `sharedGroups` array directly.
 *     `const group = instanceGroupManager.sharedGroups[sharedGroupId]`
 *   - **High-Level/Debug (Slow Path):** For convenience outside of systems, the `getSharedGroup(id)`
 *     method can be used.
 *   - **Per-Entity Data:** Stored directly on the entity's archetype chunk as usual.
 *
 * ## 3. Contrast with Value-Based Sharing
 *
 * This system replaces the old `SharedGroupManager` (value-based sharing).
 *
 * - **Old Way (Value-Based):** Grouped entities by hashing the *values* of their shared
 *   data. This was complex, had high entity-creation overhead, and was not suitable
 *   for mutation.
 * - **New Way (Key-Based):** Groups entities by a stable, external key (`Prefab.id`).
 *   This is simpler, faster at creation time, and designed explicitly for efficient
 *   group mutation.
 */
export class PropertyGroupManager {
	constructor() {
		/**
		 * Stores the actual shared data objects, indexed by sharedGroupId.
		 * `sharedGroups[0]` is reserved for entities with no shared data.
		 * @private
		 * @type {object[]}
		 */
		this.sharedGroups = [{}] // Group 0 is always the empty object.

		// Group 0 is a special, empty, immutable group for entities with no prefab
		// or prefabs with no shared data.
		this.sharedGroups[0] = Object.freeze({})

		/**
		 * Maps a prefabId to its corresponding sharedGroupId.
		 * @private
		 * @type {Map<number, number>}
		 */
		this.prefabIdToSharedGroupId = new Map()

		// Prefab ID 0 (no prefab) maps to sharedGroupId 0.
		this.prefabIdToSharedGroupId.set(0, 0)
	}

	/**
	 * Retrieves or creates a shared data group for a given prefab ID and returns its sharedGroupId.
	 * This is typically called by the ComponentManager during entity creation.
	 * @param {number} prefabId - The numeric ID of the prefab.
	 * @param {object} initialSharedData - An object where keys are componentTypeIDs and values are the shared data for that component.
	 * @returns {number} The sharedGroupId for the prefab.
	 */
	getOrCreateSharedGroup(prefabId, initialSharedData) {
		if (this.prefabIdToSharedGroupId.has(prefabId)) {
			return this.prefabIdToSharedGroupId.get(prefabId)
		}

		// Create a new shared group.
		const newSharedGroupId = this.sharedGroups.length
		this.sharedGroups[newSharedGroupId] = {} // Initialize with an empty object

		// We create a deep copy to ensure the initial data from the prefab cache
		// is not mutated, allowing it to be a clean template for other variants.
		const newGroup = JSON.parse(JSON.stringify(initialSharedData))
		this.sharedGroups[newSharedGroupId] = newGroup

		this.prefabIdToSharedGroupId.set(prefabId, newSharedGroupId)

		return newSharedGroupId
	}

	/**
	 * Adds new shared data to a prefab's group, creating the group if it doesn't exist.
	 * This is used when dynamically adding a component with shared properties to an existing entity.
	 * @param {number} prefabId - The numeric ID of the prefab.
	 * @param {object} newSharedData - The new shared data to merge, keyed by componentTypeId.
	 * @returns {number} The sharedGroupId for the prefab.
	 */
	addSharedDataToGroup(prefabId, newSharedData) {
		if (!this.prefabIdToSharedGroupId.has(prefabId)) {
			// This prefab had no shared components before. Create a new group for it.
			const newSharedGroupId = this.sharedGroups.length
			const newGroup = JSON.parse(JSON.stringify(newSharedData)) // Deep copy
			this.sharedGroups[newSharedGroupId] = newGroup
			this.prefabIdToSharedGroupId.set(prefabId, newSharedGroupId)
			return newSharedGroupId
		}

		const sharedGroupId = this.prefabIdToSharedGroupId.get(prefabId)
		const group = this.sharedGroups[sharedGroupId]

		// Merge the new data into the existing group.
		for (const typeId in newSharedData) {
			group[typeId] = { ...(group[typeId] || {}), ...newSharedData[typeId] }
		}
		return sharedGroupId
	}

	/**
	 * Retrieves the shared data group for a given sharedGroupId.
	 * This is the primary "read" method for systems.
	 * @param {number} sharedGroupId - The numeric ID of the shared group.
	 * @returns {object | undefined} The shared data group, or undefined if the ID is invalid.
	 */
	getSharedGroup(sharedGroupId) {
		return this.sharedGroups[sharedGroupId]
	}

	/**
	 * Retrieves the shared data for a specific component within a shared group.
	 * @param {number} sharedGroupId - The numeric ID of the shared group.
	 * @param {number} componentTypeId - The numeric ID of the component.
	 * @returns {object | undefined} The shared data for that component, or undefined.
	 */
	getComponentData(sharedGroupId, componentTypeId) {
		return this.sharedGroups[sharedGroupId]?.[componentTypeId]
	}
}

export const propertyGroupManager = new PropertyGroupManager()