import { DirtyMarker } from './DirtyMarker.js'
import { SoAArchetypeAccessor } from './Accessors.js'

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
     * @param {import('./ArchetypeManager.js').ArchetypeManager} archetypeManager The manager that owns this chunk's archetype.
     * @param {number} capacity The maximum number of entities this chunk can hold.
     */
    constructor(archetype, archetypeManager, capacity) {
        this.archetype = archetype
        this.capacity = capacity
		this.archetypeManager = archetypeManager
        this.size = 0 // Current number of entities in the chunk

        // Caches for flyweight objects to reduce allocations
        this.accessorCache = []
        this.markerCache = []
		this.constants = {} // Populated by Query iterators for zero-overhead access in systems.

        // Array to store the entity IDs.
        this.entities = new Uint32Array(capacity)

        // SoA data storage
        this.componentArrays = []
        this.dirtyTicksArrays = []

        // Initialize data structures for each component in the archetype
		const componentTypeIDs = this.archetypeManager.archetypeComponentTypeIDs[this.archetype]
        for (const typeID of componentTypeIDs) {
            const info = this.archetypeManager.componentManager.componentInfo[typeID]
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
     * @param {number} entityId The ID of the entity to add.
     * @returns {number} The index of the newly added entity within the chunk.
     */
    addEntity(entityId) {
        const index = this.size
        this.entities[index] = entityId
        this.size++
        return index
    }

    /**
     * Removes an entity from the chunk by its index using the swap-and-pop method.
     * This is a convenience wrapper around the more performant `removeEntitiesAtIndexes`.
     * @param {number} indexToRemove The index of the entity to remove.
     * @returns {Map<number, number>} A map of `swappedEntityId -> newIndex`.
     */
    removeEntityAtIndex(indexToRemove) {
        if (indexToRemove >= this.size || indexToRemove < 0) {
            return new Map()
        }
        return this.removeEntitiesAtIndexes([indexToRemove])
    }

    /**
     * The core batch removal function. Removes multiple entities from the chunk efficiently.
     * It performs a "multi-swap-and-pop", moving entities from the end of the chunk
     * to fill the gaps left by the removed entities.
     * @param {number[]} sortedIndicesToRemove - An array of indices to remove, **must be sorted in descending order**.
     * @returns {Map<number, number>} A map of `swappedEntityId -> newIndex` for entities that were moved.
     */
    removeEntitiesAtIndexes(sortedIndicesToRemove) {
        const numToRemove = sortedIndicesToRemove.length
        if (numToRemove === 0) {
            return new Map()
        }

        const swappedMappings = new Map()
        let lastIndex = this.size - 1

        for (const indexToRemove of sortedIndicesToRemove) {
            if (indexToRemove > lastIndex) {
                continue
            }

            const isLastElement = indexToRemove === lastIndex
            
            if (!isLastElement) {
                const swappedEntityId = this.entities[lastIndex]
                this.entities[indexToRemove] = swappedEntityId
                swappedMappings.set(swappedEntityId, indexToRemove)

                // Move component data using optimized block copies
				const componentTypeIDs = this.archetypeManager.archetypeComponentTypeIDs[this.archetype]
                for (const typeID of componentTypeIDs) {
					const propArrays = this.componentArrays[typeID]
					const info = this.archetypeManager.componentManager.componentInfo[typeID]
                    for (const propKey of info.propertyKeys) {
                        // Use copyWithin for efficient intra-array copying
                        propArrays[propKey].copyWithin(indexToRemove, lastIndex, lastIndex + 1)
                    }
                    this.dirtyTicksArrays[typeID].copyWithin(indexToRemove, lastIndex, lastIndex + 1)
                }
            }
            
            lastIndex--
        }

        this.size -= numToRemove
        return swappedMappings
    }


	getComponentAccessor(typeID) {
		if (this.accessorCache[typeID]) {
			return this.accessorCache[typeID]
		}
		const accessor = new SoAArchetypeAccessor(this, typeID)
		this.accessorCache[typeID] = accessor
		return accessor
	}

	getDirtyMarker(typeID, currentTick) {
		if (!this.archetypeManager.hasComponentType(this.archetype, typeID)) return undefined

		let marker = this.markerCache[typeID]
		if (!marker) {
			marker = new DirtyMarker()
			this.markerCache[typeID] = marker
		}

		marker._init(this.dirtyTicksArrays[typeID], currentTick)

		if (currentTick > this.archetypeManager.archetypeMaxDirtyTicks[this.archetype]) {
			this.archetypeManager.archetypeMaxDirtyTicks[this.archetype] = currentTick
		}

		return marker
	}
}
