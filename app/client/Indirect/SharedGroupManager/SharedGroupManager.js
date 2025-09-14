//! Depricated due to entity creation overhead for little benefit
//! Filtering can be achieved by other means.


/**
 * Manages unique groups of shared component data.
 * This is the storage backend for the "Shared Components as Indirect References" pattern.
 *
 * ---
 * # Developer Note: Working with Shared Groups
 * ---
 *
 * ## 1. Overview & Purpose
 *
 * The primary purpose of this manager is to de-duplicate **static, immutable component data** to:
 * 1.  **Save Memory:** Identical data (e.g., `{ value: 'common' }`) is stored only once.
 * 2.  **Prevent Archetype Fragmentation:** Entities with different values for a shared component
 *     (e.g., `Rarity: 'common'` vs `Rarity: 'rare'`) can live in the same archetype, because
 *     the underlying component schema is identical (`{ groupId: 'u32' }`).
 *
 * ### CRITICAL: This is a "Write-Once" System
 *
 * This system is designed for data that does not change after an entity is created.
 * A `groupId` is assigned once during entity creation. There is **no built-in,
 * efficient mechanism to change a shared value at runtime and have the entity
 * automatically move to a new group.**
 *
 * Attempting to modify shared data in a system would require manually reconstructing
 * the entity's data signature and moving it to a new archetype, which is highly
 * inefficient and defeats the purpose of this optimization.
 *
 * **Use Case:** Perfect for large numbers of short-lived, "fire-and-forget" entities
 * like projectiles, or for truly static scenery objects.
 *
 * **Lifecycle Warning:** Be cautious with entities that change state, like loot.
 * An item on the ground can be static, but once picked up and placed in an inventory,
 * it may become mutable (e.g., durability changes). This pattern is not suitable for
 * such entities unless the "ground item" and "inventory item" are treated as
 * separate entities with different lifecycles.
 *
 * **Anti-Pattern:** Do not use for dynamic data like current health, status effect durations, or anything
 * that needs to be modified during gameplay.
 *
 * ## 2. Advanced Use Case: The "Data Signature" Pattern
 *
 * While memory optimization is the primary goal, a powerful secondary use case emerges:
 * **high-speed group filtering**.
 *
 * When an entity is created, all of its shared properties from all of its components are
 * combined into a single "data signature." This manager hashes that signature and assigns
 * it a single, unique `groupId`. This `groupId` is then written to all of the entity's
 * shared components.
 *
 * This allows a system to pre-calculate the `groupId` for a specific combination of static
 * properties it cares about, and then use a single, fast integer comparison inside its
 * update loop to find all entities matching that exact signature.
 *

 * ```
 */

/**
 * A fast, non-cryptographic hash function for combining numbers.
 * This is a variant of the FNV-1a hash, adapted for our use case.
 * It's designed to be fast and provide good distribution for our object hashing.
 * @param {number} h - The current hash value.
 * @param {number} n - The new number to mix into the hash.
 * @returns {number} The new hash value.
 */
function mix(h, n) {
	h = Math.imul(h ^ n, 0x85ebca6b)
	h = Math.imul(h ^ (h >>> 16), 0x27d4eb2d)
	h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35)
	return h ^ (h >>> 16)
}

/**
 * Performs a deep equality check between two objects.
 * This is a simplified version, sufficient for our flat data objects.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function deepEquals(a, b) {
	const keysA = Object.keys(a)
	const keysB = Object.keys(b)

	if (keysA.length !== keysB.length) return false

	for (const key of keysA) {
		const valA = a[key]
		const valB = b[key]

		const areObjects = typeof valA === 'object' && valA !== null && typeof valB === 'object' && valB !== null

		if (areObjects && !deepEquals(valA, valB)) {
			return false
		} else if (!areObjects && valA !== valB) {
			return false
		}
	}
	return true
}

/**
 * Generates a deterministic hash from a shared data object.
 * It avoids slow stringification by iterating keys and values directly.
 * @param {object} obj - The object to hash. Keys are componentTypeIDs.
 */
function hashSharedObject(obj) {
	let h = 0
	const componentTypeIDs = Object.keys(obj).sort() // Sort for determinism
	for (const typeId of componentTypeIDs) {
		h = mix(h, Number(typeId))
		const componentData = obj[typeId]
		const propKeys = Object.keys(componentData).sort() // Sort for determinism
		for (const propKey of propKeys) {
			// We can't easily hash the string key, but since schemas are fixed,
			// the order is deterministic. We just hash the value.
			h = mix(h, componentData[propKey])
		}
	}
	return h
}

export class SharedGroupManager {
	constructor() {
		/**
		 * Stores the actual shared data objects, indexed by groupId.
		 * @private
		 * @type {object[]}
		 */
		this.groups = [{}] // Group 0 is always the empty object for entities with no shared data.

		/**
		 * Maps a hash of a shared data object to its groupId.
		 * To handle collisions, this maps a hash to an array of potential groupIds.
		 * @private
		 * @type {Map<number, number[]>}
		 */
		this.hashToGroupId = new Map() // hash -> [groupId, ...]
		this.hashToGroupId.set(0, 0) // Hash of an empty object is 0
	}

	/**
	 * Finds or creates a group for a given combination of shared data.
	 * @param {object} sharedData - An object where keys are componentTypeIDs and values are the processed component data.
	 * @returns {number} The groupId for the shared data.
	 */
	getGroupId(sharedData) {
		if (!sharedData || Object.keys(sharedData).length === 0) {
			return 0 // Return the default empty group.
		}

		const dataHash = hashSharedObject(sharedData)

		if (this.hashToGroupId.has(dataHash)) {
			const potentialGroupIds = this.hashToGroupId.get(dataHash)
			for (const groupId of potentialGroupIds) {
				// Deep compare to ensure it's a true match, not a hash collision.
				if (deepEquals(this.groups[groupId], sharedData)) {
					return groupId
				}
			}
			// If we are here, it was a hash collision but not a data match.
			// We'll proceed to create a new group and add it to the list for this hash.
		}

		const newGroupId = this.groups.length
		this.groups[newGroupId] = sharedData

		if (!this.hashToGroupId.has(dataHash)) {
			this.hashToGroupId.set(dataHash, [])
		}
		this.hashToGroupId.get(dataHash).push(newGroupId)

		return newGroupId
	}
}

export const sharedGroupManager = new SharedGroupManager()
