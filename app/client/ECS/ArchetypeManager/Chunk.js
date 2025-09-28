import { DirtyMarker } from './DirtyMarker.js'
import * as Schema from '../ComponentManager/ComponentSchema.js'

/**
 * @file Defines the Chunk class for the ECS architecture.
 * A Chunk is a contiguous block of memory that stores entities and their associated component data
 * for a specific archetype, using a Structure of Arrays (SoA) layout for performance.
 */

/**
 * Represents a fixed-size chunk of memory for a specific archetype.
 * It holds a set of entities and their component data in an SoA layout.
 */
export class Chunk {
	/**
	 * @param {number} archetype The ID of the archetype this chunk belongs to.
	 * @param {number} capacity The maximum number of entities this chunk can hold.
	 * @param {Set<number>} componentTypeIDs The set of component type IDs for this archetype, used only for initialization.
	 */
	constructor(archetype, capacity, componentTypeIDs) {
		this.archetype = archetype
		this.capacity = capacity
		this.size = 0 // Current number of entities in the chunk
		this.lastDirtyTick = 0 // The last tick any component in this chunk was modified.

		// Caches for flyweight objects to reduce allocations
		this.accessorCache = []
		this.markerCache = []

		// Array to store the entity IDs.
		this.entities = new BigUint64Array(capacity)

		// SoA data storage
		this.componentArrays = []
		this.dirtyTicksArrays = []

		// Initialize data structures for each component in the archetype
		for (const typeID of componentTypeIDs) {
			const info = Schema.componentInfo[typeID]
			const propArrays = {}
			for (const propKey of info.propertyKeys) {
				const constructor = info.properties[propKey].arrayConstructor
				const buffer = new SharedArrayBuffer(capacity * constructor.BYTES_PER_ELEMENT)
				propArrays[propKey] = new constructor(buffer)
			}
			this.componentArrays[typeID] = propArrays

			this.dirtyTicksArrays[typeID] = new Uint32Array(capacity)
		}
	}

	/**
	 * Checks if the chunk is full.
	 * @returns {boolean} True if the chunk has reached its capacity, false otherwise.
	 */
	isFull() {
		return this.size >= this.capacity
	}

	/**
	 * Adds an entity to the chunk and returns its index.
	 * Does not set component data.
	 * @param {bigint} entityId The ID of the entity to add.
	 * @returns {number} The index of the newly added entity within the chunk.
	 */
	addEntity(entityId) {
		const index = this.size
		this.entities[index] = entityId
		this.size++
		return index
	}

	/**
	 * Checks if this chunk's archetype includes a specific component.
	 * This is a high-performance check intended for use within system loops,
	 * especially for resolving `anyOf` queries.
	 * @param {number} componentTypeId The numeric type ID of the component.
	 * @returns {boolean} True if entities in this chunk have the component.
	 */
	hasComponent(componentTypeId) {
		// The most reliable check is whether the data array for this component exists.
		return this.componentArrays[componentTypeId] !== undefined
	}

	getDirtyMarker(typeID, currentTick) {
		if (!this.hasComponent(typeID)) return undefined

		let marker = this.markerCache[typeID]
		if (!marker) {
			marker = new DirtyMarker(this)
			this.markerCache[typeID] = marker
		}

		marker._init(this.dirtyTicksArrays[typeID], currentTick)

		return marker
	}
}
