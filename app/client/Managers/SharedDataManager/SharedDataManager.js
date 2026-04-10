import * as Schema from '../ComponentManager/ComponentSchema.js'

const INITIAL_CAPACITY = 256 // Initial capacity for shared data arrays
const { componentInfo } = Schema

/**
 * @deprecated This manager is a temporary implementation and is slated for replacement.
 *
 * This is an experimental iteration on solving the shared component data problem.
 * Its goal was to avoid archetype fragmentation while saving memory. However, the current
 * implementation has significant drawbacks:
 * - **Performance:** Slow read/write paths due to multiple indirections.
 * - **Parallelism:** Not thread-safe. 
 * - **Complexity:** The "variant" system for overrides adds runtime complexity and prototype fragmentation.
 *
 * This file will be removed or completely refactored in a future.
 */

//! TODO remove from the engine at some point, it is still everywhere...


export class SharedDataManager {
	constructor() {
		/**
		 * "Flyweight" store for actual shared data values, organized by component type ID.
		 * @type {Object.<number, { _nextIndex: number, [propKey: string]: TypedArray }>}
		 */
		this.valueStores = {}

		/**
		 * A cache to map a hash of shared data values to a `sharedDataIndex`.
		 * @type {Object.<number, Map<string, number>>}
		 */
		this.valueHashes = {}

		/**
		 * "Prototype" store. An array where index is `prototypeId`.
		 * Each entry is an object mapping `componentTypeId` to a `sharedDataIndex`.
		 * @type {object[]}
		 */
		this.prototypeStore = []

		/**
		 * A cache to map a hash of a prototype object to a `prototypeId`.
		 * @type {Map<string, number>}
		 */
		this.prototypeHashes = new Map()
	}

	/**
	 * Initializes shared data stores for all components that have shared properties.
	 * This is called once by ComponentManager after all schemas are parsed.
	 */
	init(componentManager) {
		for (let typeId = 0; typeId < Schema.nextComponentTypeID; typeId++) {
			const info = componentInfo[typeId]
			if (!info || info.sharedProperties.length === 0) continue

			// Create value store for this component type
			const store = { _nextIndex: 1 } // Index 0 is reserved
			this.valueStores[typeId] = store
			this.valueHashes[typeId] = new Map()

			// Create TypedArrays for each shared property
			for (const propKey of info.sharedProperties) {
				const propInfo = info.properties[propKey]
				if (propInfo) {
					store[propKey] = new propInfo.arrayConstructor(INITIAL_CAPACITY)
				}
			}
		}

		// Initialize prototype 0 as empty prototype for entities without shared data.
		this.prototypeStore[0] = Object.freeze({})
		this.prototypeHashes.set('{}', 0)
	}

	/**
	 * Gets index for a given set of shared data values, creating a new entry if one doesn't exist.
	 * @param {number} componentTypeId - type ID of component.
	 * @param {object} values - An object of the shared property values (e.g., `{ duration: 5.0 }`).
	 * @returns {number} unique `sharedDataIndex` for this set of values.
	 */
	getOrCreateSharedDataIndex(componentTypeId, values) {
		const hashCache = this.valueHashes[componentTypeId]
		if (!hashCache) return 0 // This component has no shared properties.

		const key = JSON.stringify(values)

		let index = hashCache.get(key)
		if (index !== undefined) return index

		// --- Create a new entry ---
		const store = this.valueStores[componentTypeId]
		index = store._nextIndex++

		// Check if we need to resize the value store's TypedArrays.
		const firstPropKey = componentInfo[componentTypeId]?.sharedProperties[0]
		if (firstPropKey && index >= store[firstPropKey].length) {
			const oldCapacity = store[firstPropKey].length
			const newCapacity = oldCapacity * 2

			// Resize all TypedArrays for this component's shared properties.
			for (const propKey of componentInfo[componentTypeId].sharedProperties) {
				const propInfo = componentInfo[componentTypeId].properties[propKey]
				if (propInfo) {
					const oldArray = store[propKey]
					const newArray = new propInfo.arrayConstructor(newCapacity)
					newArray.set(oldArray) // Copy old data to new, larger array.
					store[propKey] = newArray
				}
			}
		}

		// Write new values into shared arrays at new index.
		const info = componentInfo[componentTypeId]
		for (const propKey of info.sharedProperties) {
			if (values[propKey] !== undefined) {
				const value = values[propKey]
				// Explicitly handle BigInts for non-BigInt arrays
				if (typeof value === 'bigint' && !store[propKey].constructor.name.startsWith('Big')) {
					store[propKey][index] = Number(value & 0xffffffffn) // Truncate to 32 bits
				} else {
					store[propKey][index] = value
				}
			}
		}

		// Cache hash for next time.
		hashCache.set(key, index)

		return index
	}

	/**
	 * Gets ID for a given prototype, creating a new one if it doesn't exist.
	 * A prototype is a map of { componentTypeId: sharedDataIndex }.
	 * @param {object} prototypeData - prototype object to find or create.
	 * @returns {number} unique `prototypeId`.
	 */
	getOrCreatePrototype(prototypeData) {
		const key = JSON.stringify(prototypeData)
		let id = this.prototypeHashes.get(key)
		if (id !== undefined) return id

		id = this.prototypeStore.length
		this.prototypeStore[id] = prototypeData
		this.prototypeHashes.set(key, id)
		return id
	}

	/**
	 * Creates a new prototype by copying and modifying an existing one.
	 * This is core of per-entity variation.
	 * @param {number} basePrototypeId - ID of prototype to copy.
	 * @param {number} componentTypeId - component to modify in new prototype.
	* @param {number} newSharedDataIndex - new `sharedDataIndex` for modified component.
	 * @returns {number} `prototypeId` of new or existing matching prototype.
	 */
	createVariantPrototype(basePrototypeId, componentTypeId, newSharedDataIndex) {
		const basePrototype = this.prototypeStore[basePrototypeId]
		if (!basePrototype) {
			console.error(`SharedDataManager: Cannot create variant from non-existent prototype ID ${basePrototypeId}`)
			return 0
		}

		// Create a new prototype object by copying base and applying change.
		const newPrototype = { ...basePrototype }
		newPrototype[componentTypeId] = newSharedDataIndex

		// This will either find an existing prototype that matches this new configuration
		// or create a new one.
		return this.getOrCreatePrototype(newPrototype)
	}

	/**
	 * Finds all prototype IDs that are associated with a given prefab ID.
	 * This includes the original prototype for the prefab and any variants that
	 * have been created from it. This is the helper method for performing
	 * efficient group-wide updates on all instances of a prefab.
	 *
	 * @param {number} prefabId - The numeric ID of the prefab to search for.
	 * @returns {number[]} An array of matching prototype IDs.
	 */
	getPrototypesByPrefabId(prefabId) {
		const matchingPrototypes = []
		const prefabTypeId = Schema.componentNameToTypeID.get('prefab')

		if (prefabTypeId === undefined) {
			console.warn('SharedDataManager: Prefab component is not registered. Cannot get prototypes by prefab ID.')
			return []
		}

		const prefabValueStore = this.valueStores[prefabTypeId]
		if (!prefabValueStore) return [] // No prefabs have been instantiated yet.

		// This is an O(P) operation where P is the total number of unique prototypes in the world.
		// This is acceptable as P is expected to be much smaller than the number of entities.
		for (let i = 0; i < this.prototypeStore.length; i++) {
			const prototype = this.prototypeStore[i]
			const prefabDataIndex = prototype[prefabTypeId]

			if (prefabDataIndex !== undefined && prefabValueStore.id[prefabDataIndex] === prefabId) {
				matchingPrototypes.push(i)
			}
		}
		return matchingPrototypes
	}
}

export const sharedDataManager = new SharedDataManager()