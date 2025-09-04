/**
 * @fileoverview Manages unique groups of shared component data.
 * This is the storage backend for the "Shared Components as Indirect References" pattern.
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