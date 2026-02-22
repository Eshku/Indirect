import * as Schema from '../ComponentManager/ComponentSchema.js'
/**
 * Manages all entities, archetypes, and their component data.
 * This class is the heart of the ECS, owning the core data structures that track every entity.
 * It provides methods for all structural changes: creating/destroying entities and adding/removing components.
 *
 * --- `entityStore` Breakdown ---
 *
 * 1.  **Entity Management (`entityVersion`, `entityLocations`, `generations`):**
 *     -   These arrays track the state and location of every entity ID. They are managed exclusively by the
 *         main thread and are not directly shared with workers, as workers only need to know about chunks.
 *     -   To solve the "stale ID" problem (where an old entity ID could be recycled and incorrectly refer to a
 *         new entity), we use **Generational Entity IDs**. Each ID is a `BigInt` (64-bit unsigned integer)
 *         composed of multiple parts:
 *
 * | Part        | Bits    | Description                                             |
 * |-------------|---------|---------------------------------------------------------|
 * | Placeholder | 1 bit   | (MSB) A flag to mark the ID as a temporary placeholder. |
 * | Generation  | 31 bits | A counter that increments each time an index is reused. |
 * | Index       | 32 bits | A stable index into internal entity arrays.             |
 *
 *     -   **Index (lower 32 bits):** A direct, reusable index into arrays like `entityLocations` and `entityVersion`.
 *     -   **Generation (middle 31 bits):** When an entity at `index` is destroyed, its generation counter in the
 *         `generations` array is incremented. The next entity created at that `index` will have the new generation.
 *         An old ID with a stale generation will fail validation.
 *     -   **Placeholder Flag (bit 63):** The most significant bit is reserved. If set, it marks the ID as a
 *         "placeholder," a temporary ID created by a worker thread that will be resolved to a real entity ID by
 *         the main thread. This is a critical feature for enabling parallel entity creation.
 *
 * 2.  **Archetype Management (`archetypeMasks`, `archetypeComponentTypeIDArrays`):**
 *     -   An archetype represents a unique combination of components.
 *     -   `archetypeComponentTypeIDArrays`: This is a pre-allocated `new Array(MAX_ARCHETYPES)`. Each element
 *         is a `Uint16Array` (backed by a `SharedArrayBuffer`) listing the component type IDs for that archetype.
 *         This pre-allocated array acts as a "shareable container," solving the "Stale Archetype" problem by
 *         ensuring that when the main thread creates a new archetype, workers can immediately and safely read its structure.
 *
 * 3.  **Chunk Metadata (`chunkArchetypeIds`, `chunkSizes`, `chunkCapacities`):**
 *     -   These are large `TypedArray`s, each backed by a single `SharedArrayBuffer`.
 *     -   They provide fast, parallel-safe access to metadata for any chunk. For example, any thread can
 *         read `chunkSizes[chunkId]` to know how many entities are in a chunk.
 *
 * 4.  **Chunk Component Data (`chunkComponentData`, `chunkDirtyTicks`):**
 *     -   This is the most critical part of the shared architecture.
 *     -   `chunkComponentData` is a pre-allocated `new Array(MAX_CHUNKS)`. It is **not** one giant contiguous
 *         buffer. It is a sparse array that holds references to individual chunk data objects.
 *     -   Each element, `chunkComponentData[chunkId]`, is a separate object that contains the actual `SharedArrayBuffer`-backed
 *         `TypedArray`s for that specific chunk's component data (e.g., `{ entities: BigUint64Array, 5: { x: Float32Array, ... } }`).
 *     -   This structure ensures that when workers process different chunks, they are writing to completely
 *         separate memory buffers, eliminating data contention for component data.
 * 
 *     -   **Architectural Choice: Per-Property Buffers vs. A Single Continuous Buffer**
 *         The engine's "Per-Property SoA" model (separate buffers for each component property) was chosen
 *         over the "Continuous SoA" model (a single, giant buffer for all data in a chunk).
 *
 *         -   **Iteration Speed:** The Continuous SoA model shows a minor (~5-10%) performance advantage in
 *             benchmarks for multi-property access. However, the Per-Property model is still exceptionally
 *             fast, providing optimal, cache-friendly linear memory access.
 *
 *         -   **Structural Changes (The Deciding Factor):** The Continuous SoA model is catastrophically
 *             slow for structural changes. A "swap-and-pop" operation
 *             requires multiple, large, cache-trashing memory copies (`copyWithin`) to keep the data
 *             contiguous. The Per-Property model performs the same operation with a few, cheap value
 *             assignments.
 *
 *         -   **Memory Management:** The current model's chunk pooling is highly efficient. A freed chunk can
 *             be instantly re-purposed for any archetype. A single-buffer model leads to severe
 *             memory fragmentation, as memory allocated for one archetype cannot be easily used by another.
 *
 *         **Conclusion:** The engine's architecture makes a deliberate trade-off, accepting a negligible
 *         iteration speed deficit to gain massive, orders-of-magnitude advantages in the speed of
 *         structural changes and memory efficiency. This is the correct and most robust choice.
 *
 * --- Data Lookup Flow (Worker Thread) ---
 *
 * A worker receives a job for `chunkId: 5`.
 *
 * 1.  **Get Chunk Metadata:**
 *     -   `const archetypeId = entityStore.chunkArchetypeIds[5];`
 *     -   `const size = entityStore.chunkSizes[5];`
 *
 * 2.  **Get Archetype Structure:**
 *     -   `const componentList = entityStore.archetypeComponentTypeIDArrays[archetypeId];`
 *     -   This lookup succeeds because `archetypeComponentTypeIDArrays` is a shared container. The worker now knows
 *         which components are in this chunk.
 *
 * 3.  **Get Component Data Buffers:**
 *     -   `const dataForChunk5 = entityStore.chunkComponentData[5];`
 *     -   This lookup succeeds because `chunkComponentData` is a shared container.
 *     -   The worker can now access the raw data arrays: `const positions = dataForChunk5[positionTypeId];`
 */


export const MAX_ARCHETYPES = 4096
export const MAX_CHUNKS = 65536
const TARGET_CHUNK_SIZE_BYTES = 16384 // 16KB

const CACHE_LINE_SIZE = 64 // Common CPU cache line size in bytes
const CACHE_LINE_SIZE_IN_U32 = CACHE_LINE_SIZE / Uint32Array.BYTES_PER_ELEMENT

const MIN_CHUNK_CAPACITY = 16

export const entityStore = {
	// --- Entity Management ---
	entityVersion: [],
	entityLocations: [],
	generations: [],
	freeIndices: [],
	nextEntityIndex: 1,

	// --- Archetype Management ---
	archetypeLookup: new Map(),
	nextArchetypeId: 0,
	archetypeMasks: new Array(MAX_ARCHETYPES),
	// This is now pre-allocated to ensure workers can see new archetypes added at runtime.
	archetypeComponentTypeIDArrays: new Array(MAX_ARCHETYPES),
	archetypeChunks: new Array(MAX_ARCHETYPES),
	archetypeTransitions: new Array(MAX_ARCHETYPES),
	archetypeLastNonFullChunk: [],

	// --- Chunk Management ---
	nextChunkId: 0,
	freeChunkIds: [],
	chunkArchetypeIds: new Uint16Array(new SharedArrayBuffer(MAX_CHUNKS * Uint16Array.BYTES_PER_ELEMENT)),
	chunkSizes: new Uint16Array(new SharedArrayBuffer(MAX_CHUNKS * Uint16Array.BYTES_PER_ELEMENT)),
	chunkCapacities: new Uint16Array(new SharedArrayBuffer(MAX_CHUNKS * Uint16Array.BYTES_PER_ELEMENT)),

	// These are now pre-allocated to ensure workers can see new chunks added at runtime.
	// They are not SharedArrayBuffers themselves, but they hold SABs.
	// The array itself is what needs to be shared in structure.
	chunkComponentData: new Array(MAX_CHUNKS),
	chunkDirtyTicks: new Array(MAX_CHUNKS),
	chunkArchetypeDirtyTicks: new Array(MAX_CHUNKS),
}

export class EntityManager {
	constructor() {
		// This class no longer owns the store. It operates on the shared, exported entityStore.
		// this.store = entityStore // No longer needed.

		// --- Manager References ---
		this.queryManager = null
		this.componentManager = null
		this.systemManager = null
		this.prefabManager = null

		// Tracks chunk IDs created within a single frame for delta-syncing to workers.
		this.newlyCreatedChunks = []
		this.destroyedChunks = []
		this.newlyCreatedArchetypes = []
	}

	async init(ecs) {
		this.queryManager = ecs.queryManager
		this.componentManager = ecs.componentManager
		this.systemManager = ecs.systemManager
		this.prefabManager = ecs.prefabManager
	}

	/**
	 * Gathers all SharedArrayBuffers and metadata required for workers to reconstruct
	 * a view of the world state. This is called once during worker initialization.
	 * @returns {object} A serializable object containing all shared data.
	 */
	getSharedData() {
		return {
			// --- Chunk Metadata ---
			chunkArchetypeIds: entityStore.chunkArchetypeIds.buffer,
			chunkSizes: entityStore.chunkSizes.buffer,
			chunkCapacities: entityStore.chunkCapacities.buffer,

			// --- Shared Data Structures ---
			// We pass the pre-allocated container arrays directly. Workers will get a
			// reference to these, allowing them to see new archetypes as they are added.
			archetypeComponentTypeIDArrays: entityStore.archetypeComponentTypeIDArrays,
			chunkArchetypeDirtyTicks: entityStore.chunkArchetypeDirtyTicks,

			// --- Constants & Limits ---
			MAX_CHUNKS: MAX_CHUNKS,
		}
	}

	/**
	 * Gathers the data for all newly created chunks since the last call
	 * and then clears the tracking lists. This is for delta-syncing to workers.
	 * @returns {{newChunks: object | null, destroyedChunks: number[] | null}} An object containing deltas.
	 */
	getAndClearChunkDeltas() {
		let newArchetypes = null
		if (this.newlyCreatedArchetypes.length > 0) {
			newArchetypes = [...this.newlyCreatedArchetypes]
		}
		this.newlyCreatedArchetypes.length = 0

		let newChunks = null
		if (this.newlyCreatedChunks.length > 0) {
			newChunks = {}
			for (const chunkId of this.newlyCreatedChunks) {
				newChunks[chunkId] = {
					data: entityStore.chunkComponentData[chunkId],
					ticks: entityStore.chunkDirtyTicks[chunkId],
					archetypeTicks: entityStore.chunkArchetypeDirtyTicks[chunkId],
				}
			}
		}
		this.newlyCreatedChunks.length = 0 // Clear the list for the next frame.

		let destroyedChunks = null
		if (this.destroyedChunks.length > 0) {
			// We can send the array directly.
			destroyedChunks = [...this.destroyedChunks]
		}
		this.destroyedChunks.length = 0

		return { newChunks, destroyedChunks, newArchetypes }
	}

	/**
	 * A helper for workers to get access to component data for a specific chunk.
	 * In a worker context, `this.chunkComponentData` would be the shared data object.
	 * @param {number} chunkId The ID of the chunk.
	 * @returns {{entities: BigUint64Array, [typeId: number]: {[propKey: string]: TypedArray}}}
	 */
	getSharedComponentData(chunkId) {
		return entityStore.chunkComponentData[chunkId]
	}

	/**
	 * A helper to get the dirty tick data for a specific chunk.
	 * @param {number} chunkId The ID of the chunk.
	 * @returns {object}
	 */
	getSharedDirtyTicks(chunkId) {
		return entityStore.chunkDirtyTicks[chunkId]
	}

	createEntity() {
		return this._createEntityId()
	}

	/**
	 * Creates a batch of identical entities in a specific archetype.
	 * @param {number} archetypeId - ID of archetype to create entities in.
	 * @param {ArrayBuffer} payload - pre-compiled AoS binary payload for one entity.
	 * @param {number} count - number of entities to create.
	 * @param {number} currentTick - current game tick for change detection.
	 */
	createIdenticalEntitiesInArchetype(archetypeId, payload, count, currentTick) {
		const entityIDs = []
		for (let i = 0; i < count; i++) {
			entityIDs.push(this._createEntityId())
		}

		this._addIdenticalEntitiesBatch(archetypeId, entityIDs, payload, currentTick)

		return entityIDs
	}

	/**
	 * Creates a single entity from a pre-compiled binary SoA payload.
	 * "fast path" for single entity creation.
	 * @param {number} archetypeId target archetype for entity.
	 * @param {ArrayBuffer} binarySoAPayload binary SoA-structured payload data.
	 * @param {number} currentTick current game tick.
	 */
	createEntityFromBinarySoAPayload(archetypeId, binarySoAPayload, currentTick) {
		if (archetypeId === undefined) return
		const entityID = this._createEntityId()
		this.addEntityFromBinarySoAPayload(archetypeId, entityID, binarySoAPayload, currentTick)
		return entityID
	}

	/**
	 * Adds a component to an entity immediately. This is a slow, immediate-mode
	 * structural change. For performance, `commands.addComponent` should be used inside systems,
	 * as it defers change to be processed in an optimized batch.
	 * @param {number} entityId entity to modify.
	 * @param {number} componentTypeId type ID of component to add.
	 * @param {ArrayBuffer} data pre-compiled binary payload for new component.
	 * @returns {boolean} True on success.
	 */
	addComponent(entityId, componentTypeId, data, currentTick) {
		if (!this.isEntityActive(entityId)) return false

		const sourceArchetypeId = this.getArchetypeForEntity(entityId)
		if (this.hasComponentType(sourceArchetypeId, componentTypeId)) {
			console.warn(
				`EntityManager.addComponent: Entity ${entityId} already has component ${this.componentManager.getComponentNameByTypeID(
					componentTypeId
				)}.`
			)
			return false
		}

		const sourceArchetypeMask = entityStore.archetypeMasks[sourceArchetypeId]
		const targetArchetypeMask = sourceArchetypeMask | this.componentManager.componentBitFlags[componentTypeId]
		const targetArchetypeId = this.getArchetypeByMask(targetArchetypeMask)

		const componentsToAssign = new Map([[componentTypeId, data]])

		return this._moveEntityToNewArchetype(entityId, sourceArchetypeId, targetArchetypeId, componentsToAssign, currentTick)
	}

	/**
	 * Removes a component from an entity immediately.
	 * @param {bigint} entityId - entity to modify.
	 * @param {number} componentTypeId - type ID of component to remove.
	 * @returns {boolean} True on success.
	 */
	removeComponent(entityId, componentTypeId, currentTick) {
		if (!this.isEntityActive(entityId)) return false
		const sourceArchetypeId = this.getArchetypeForEntity(entityId)
		if (!this.hasComponentType(sourceArchetypeId, componentTypeId)) return false
		const sourceArchetypeMask = entityStore.archetypeMasks[sourceArchetypeId]
		const targetArchetypeMask = sourceArchetypeMask & ~this.componentManager.componentBitFlags[componentTypeId]
		const targetArchetypeId = this.getArchetypeByMask(targetArchetypeMask)
		return this._moveEntityToNewArchetype(entityId, sourceArchetypeId, targetArchetypeId, new Map(), currentTick)
	}

	/**
	 * Destroys a single entity, recycling its ID.
	 * @param {bigint} entityID - entity to destroy.
	 * @returns {boolean} True if entity was active and destroyed.
	 */
	destroyEntity(entityID) {
		if (!this.isEntityActive(entityID)) return false

		const index = Number(entityID & 0xffffffffn)
		const location = entityStore.entityLocations[index]
		if (location) {
			this._removeEntity(location.archetypeId, entityID, location)
		}
		entityStore.entityVersion[index] = undefined
		entityStore.entityLocations[index] = undefined
		entityStore.generations[index]++ // Increment generation on destruction
		entityStore.freeIndices.push(index)

		return true
	}

	/**
	 * Destroys a collection of entities in a highly optimized batch.
	 * @param {Set<bigint>} entityIDs - A set of entity IDs to destroy.
	 * @returns {boolean} True.
	 */
	destroyEntitiesInBatch(entityIDs) {
		if (!entityIDs || entityIDs.size === 0) return true

		const entitiesByArchetype = new Map()

		// --- Pass 1: Gather removal information ---
		// We must collect all locations BEFORE invalidating any entity IDs,
		// as a recycled ID could be re-used by a creation command in same frame,
		// overwriting location data we need for swap-and-pop.
		for (const entityId of entityIDs) {
			if (this.isEntityActive(entityId)) {
				const index = Number(entityId & 0xffffffffn)
				const location = entityStore.entityLocations[index]
				if (location) {
					if (!entitiesByArchetype.has(location.archetypeId)) entitiesByArchetype.set(location.archetypeId, [])
					entitiesByArchetype.get(location.archetypeId).push(entityId)
				} else {
					// Handle entities that exist but have no components (and thus no location).
					entityStore.freeIndices.push(index)
					entityStore.generations[index]++
					entityStore.entityVersion[index] = undefined
					// No entityLocations to clear.
				}
			}
		}

		// --- Pass 2: Perform batched removals and invalidate IDs ---
		for (const [archetype, ids] of entitiesByArchetype.entries()) {
			this._removeEntitiesBatch(archetype, ids)
			for (const entityId of ids) {
				const index = Number(entityId & 0xffffffffn)
				entityStore.freeIndices.push(index)
				entityStore.generations[index]++
				entityStore.entityVersion[index] = undefined
				entityStore.entityLocations[index] = undefined
			}
		}
		return true
	}

	/**
	 * Destroys all entities within a single chunk using the highly efficient "Mark and Reuse" strategy.
	 * This method invalidates all entities in the central registry and then resets the chunk's size to 0,
	 * making it immediately available for reuse without any memory de-allocation.
	 *
	 * @param {number} chunkId - The ID of the chunk to clear.
	 * @returns {boolean} True if the operation was successful.
	 */
	destroyAllEntitiesInChunk(chunkId) {
		const size = entityStore.chunkSizes[chunkId]
		if (size === 0) return true

		const entitiesToDestroy = entityStore.chunkComponentData[chunkId].entities

		// 1. "Mark" Phase: Invalidate all entities in the central registry.
		for (let i = 0; i < size; i++) {
			const entityId = entitiesToDestroy[i]
			const index = Number(entityId & 0xffffffffn)
			entityStore.generations[index]++ // Increment generation to invalidate old IDs.
			entityStore.entityLocations[index] = undefined
			entityStore.entityVersion[index] = undefined
			entityStore.freeIndices.push(index) // Recycle the index.
		}

		// 2. "Sweep" Phase: Invalidate the chunk by setting its size to 0.
		// The chunk's memory is NOT de-allocated. It is kept in the archetype's pool
		// to be reused, which is extremely fast and cache-friendly.
		entityStore.chunkSizes[chunkId] = 0
	}

	destroyAllEntities() {
		// This is a full reset. We can safely clear everything.
		this.clearAllArchetypes() // Removes all chunks
		this.clearAll() // Resets all entity-related arrays and counters
		entityStore.generations = [] //  Reset generation counters

		// Notify the query manager that all archetypes are gone so it can clear its queries.
		// This is critical to prevent queries from holding stale archetype IDs.
		this.queryManager.unregisterAllArchetypes()
	}

	isEntityActive(entityID) {
		if (entityID >> 63n === 1n) return false
		if (typeof entityID !== 'bigint') return false
		const index = Number(entityID & 0xffffffffn)
		return entityStore.entityVersion[index] === entityID
	}

	/**
	 * Gets archetype ID for a given entity.
	 * @param {bigint} entityId - entity ID.
	 * @returns {number | undefined} archetype (ID), or undefined if entity has no archetype.
	 */
	getArchetypeForEntity(entityId) {
		const index = Number(entityId & 0xffffffffn)
		return entityStore.entityLocations[index]?.archetypeId
	}

	/**
	 * internal workhorse for immediate-mode structural changes on a single entity.
	 * @param {number} entityId entity to move.
	 * @param {number} sourceArchetypeId entity's current archetype.
	 * @param {number} targetArchetypeId entity's destination archetype.
	 * @param {Map<number, object>} componentsToAssign A map of new component data to assign.
	 * @returns {boolean} True if move was successful.
	 * @private
	 */
	_moveEntityToNewArchetype(entityId, sourceArchetypeId, targetArchetypeId, componentsToAssign, currentTick) {
		const entityIndex = Number(entityId & 0xffffffffn) // This is the entity's index, not index-in-chunk
		const sourceLocation = entityStore.entityLocations[entityIndex]
		if (!sourceLocation) return false

		const { chunkId: sourceChunkId, indexInChunk: sourceIndex } = sourceLocation

		// 1. Allocate space in target archetype and update entity's primary records.
		const targetChunkId = this._findOrCreateChunkId(targetArchetypeId)
		const targetIndex = this._addEntityToChunk(targetChunkId, entityId)
		entityStore.entityLocations[entityIndex] = {
			archetypeId: targetArchetypeId,
			chunkId: targetChunkId,
			indexInChunk: targetIndex,
		}

		// 2. Copy existing component data from old chunk to new one.
		const copyPlan = this._getOrCreateCopyPlan(sourceArchetypeId, targetArchetypeId)

		for (const { typeID, propKey } of copyPlan.toCopy) {
			const sourceArray = entityStore.chunkComponentData[sourceChunkId][typeID][propKey]
			const targetArray = entityStore.chunkComponentData[targetChunkId][typeID][propKey]
			targetArray[targetIndex] = sourceArray[sourceIndex]
		}

		// 3. Initialize newly added components using their binary payloads.
		for (const [typeID, data] of componentsToAssign.entries()) {
			const dataView = new DataView(data)
			this._writeComponentDataFromBuffer(targetChunkId, targetIndex, typeID, dataView, 0)
		}

		// 4. Mark all components in the new location as dirty for the current tick.
		const targetComponentIdArray = entityStore.archetypeComponentTypeIDArrays[targetArchetypeId]
		const targetComponentCount = targetComponentIdArray[0]
		const archetypeDirtyTicks = entityStore.chunkArchetypeDirtyTicks[targetChunkId]

		for (let i = 1; i <= targetComponentCount; i++) {
			const typeID = targetComponentIdArray[i]
			const indexInArchetype = i - 1

			// Update per-entity tick
			entityStore.chunkDirtyTicks[targetChunkId][typeID][targetIndex] = currentTick

			// Update per-component-type high-water mark
			let oldValue = Atomics.load(archetypeDirtyTicks, indexInArchetype)
			while (currentTick > oldValue) {
				const result = Atomics.compareExchange(archetypeDirtyTicks, indexInArchetype, oldValue, currentTick)
				if (result === oldValue) break
				oldValue = result
			}
		}

		// 4. Remove entity from its source chunk (using swap-and-pop).
		this._removeEntity(sourceArchetypeId, entityId)

		return true
	}

	// --- Methods from ArchetypeManager ---

	getArchetype(componentTypeIDs) {
		const sortedTypeIDs = [...componentTypeIDs].sort((a, b) => a - b)
		const archetypeMask = this.generateArchetypeMask(sortedTypeIDs)
		return this.getArchetypeByMask(archetypeMask, sortedTypeIDs)
	}

	getArchetypeByMask(archetypeMask, sortedTypeIDs) {
		if (entityStore.archetypeLookup.has(archetypeMask)) {
			return entityStore.archetypeLookup.get(archetypeMask)
		}

		const id = entityStore.nextArchetypeId++
		if (id >= MAX_ARCHETYPES) {
			throw new Error(`EntityManager: Maximum number of archetypes (${MAX_ARCHETYPES}) reached.`)
		}

		if (sortedTypeIDs === undefined) {
			sortedTypeIDs = this.getComponentTypesFromMask(archetypeMask)
		}

		entityStore.archetypeMasks[id] = archetypeMask
		entityStore.archetypeChunks[id] = [] // This will be an array of chunk IDs
		entityStore.archetypeTransitions[id] = { add: {}, remove: {} }

		// Create a shareable TypedArray for the component IDs of this new archetype.
		// We add 1 to the length to store the count in the first element.
		const componentIdBuffer = new SharedArrayBuffer((sortedTypeIDs.length + 1) * Uint16Array.BYTES_PER_ELEMENT)
		const componentIdArray = new Uint16Array(componentIdBuffer)
		componentIdArray[0] = sortedTypeIDs.length // Store count
		componentIdArray.set(sortedTypeIDs, 1) // Store IDs
		entityStore.archetypeComponentTypeIDArrays[id] = componentIdArray

		entityStore.archetypeLastNonFullChunk[id] = 0

		this.newlyCreatedArchetypes.push({
			id: id,
			componentIdArray: componentIdArray,
		})

		entityStore.archetypeLookup.set(archetypeMask, id)
		this.queryManager.registerArchetype(id)
		return id
	}

	getComponentTypesFromMask(mask) {
		const types = []
		for (let i = 0; i < Schema.nextComponentTypeID; i++) {
			if ((mask & Schema.componentBitFlags[i]) !== 0n) types.push(i)
		}
		return types
	}

	generateArchetypeMask(componentTypeIDs) {
		let mask = 0n
		for (const typeID of componentTypeIDs) {
			if (typeID === undefined) {
				const definedComponentNames = componentTypeIDs
					.filter(id => id !== undefined)
					.map(id => Schema.componentNames[id])
					.join(', ')
				throw new TypeError(
					`EntityManager.generateArchetypeMask: Received 'undefined' in componentTypeIDs array. ` +
						`This usually means a component name was not found or was not registered. ` +
						`Provided components: [${definedComponentNames}, undefined]`
				)
			}
			mask |= Schema.componentBitFlags[typeID]
		}
		return mask
	}

	hasComponentType(archetype, componentTypeID) {
		const componentIdArray = entityStore.archetypeComponentTypeIDArrays[archetype]
		if (!componentIdArray) return false

		// The array format is [count, id1, id2, ...]. We search from index 1.
		const count = componentIdArray[0]
		let low = 1
		let high = count

		// Perform a binary search on the sorted array of component IDs.
		// This is O(log N), which is extremely fast and avoids a linear scan.
		while (low <= high) {
			const mid = (low + high) >>> 1
			const midVal = componentIdArray[mid]

			if (midVal === componentTypeID) {
				return true
			} else if (midVal < componentTypeID) {
				low = mid + 1
			} else {
				high = mid - 1
			}
		}

		return false
	}

	/**
	 * Gets the sorted array of component type IDs for a given archetype.
	 * This is the public interface for querying an archetype's structure.
	 * @param {number} archetypeId The ID of the archetype.
	 * @returns {Uint16Array | undefined} A slice of the Uint16Array containing just the type IDs, or undefined if the archetype doesn't exist.
	 */
	getComponentTypeIDsForArchetype(archetypeId) {
		const componentIdArray = entityStore.archetypeComponentTypeIDArrays[archetypeId]
		if (!componentIdArray) {
			return undefined
		}
		// Return a slice containing only the IDs, not the count.
		return componentIdArray.slice(1)
	}

	getEntityLocation(entityId) {
		const location = entityStore.entityLocations[Number(entityId & 0xffffffffn)]
		return location?.archetypeId !== undefined ? location : undefined
	}

	clearAll() {
		entityStore.nextEntityIndex = 1
		entityStore.freeIndices.length = 0
		entityStore.entityLocations.length = 0
		entityStore.generations.length = 0
		entityStore.entityVersion.length = 0
	}

	clearAllArchetypes() {
		entityStore.archetypeLookup.clear()
		entityStore.nextArchetypeId = 0
		entityStore.archetypeMasks = new Array(MAX_ARCHETYPES)
		entityStore.archetypeComponentTypeIDArrays = new Array(MAX_ARCHETYPES)
		entityStore.archetypeChunks = new Array(MAX_ARCHETYPES)
		entityStore.archetypeTransitions = new Array(MAX_ARCHETYPES)
		entityStore.archetypeLastNonFullChunk.length = 0
		entityStore.chunkArchetypeDirtyTicks = new Array(MAX_CHUNKS)
	}

	_blitComponentDataFromBinary(chunkId, typeID, destIndices, dataOffsets, dataLengths, reader, currentTick) {
		const batchSize = destIndices.length

		for (let i = 0; i < batchSize; i++) {
			const destIndex = destIndices[i]
			const sourceOffset = dataOffsets[i]
			const sourceLength = dataLengths[i]
			const sourceView = new DataView(reader.buffer, sourceOffset, sourceLength)
			this._writeComponentDataFromBuffer(chunkId, destIndex, typeID, sourceView, 0)
		}

		for (let i = 0; i < batchSize; i++) {
			entityStore.chunkDirtyTicks[chunkId][typeID][destIndices[i]] = currentTick
		}

		// Update the per-component-type high-water mark for this chunk.
		const archetypeId = entityStore.chunkArchetypeIds[chunkId]
		const componentIdArray = entityStore.archetypeComponentTypeIDArrays[archetypeId]
		const count = componentIdArray[0]
		let indexInArchetype = -1

		// Binary search to find the component's index in the archetype's sorted list.
		let low = 1, high = count
		while (low <= high) {
			const mid = (low + high) >>> 1
			const midVal = componentIdArray[mid]
			if (midVal === typeID) {
				indexInArchetype = mid - 1
				break
			} else if (midVal < typeID) {
				low = mid + 1
			} else {
				high = mid - 1
			}
		}

		if (indexInArchetype !== -1) {
			this._updateArchetypeDirtyTick(chunkId, indexInArchetype, currentTick)
		}
	}

	_fillComponentDataFromBuffer(chunkId, typeID, sourceView, currentTick) {
		const info = Schema.componentInfo[typeID]
		// This loop is intentionally simple for JIT optimization.
		for (let i = 0; i < entityStore.chunkSizes[chunkId]; i++) {
			this._writeComponentDataFromBuffer(chunkId, i, typeID, sourceView, 0)
		}
		if (info.byteSize > 0) {
			entityStore.chunkDirtyTicks[chunkId][typeID].fill(currentTick, 0, entityStore.chunkSizes[chunkId])
		}

		// Update the per-component-type high-water mark for this chunk.
		const archetypeId = entityStore.chunkArchetypeIds[chunkId]
		const componentIdArray = entityStore.archetypeComponentTypeIDArrays[archetypeId]
		const count = componentIdArray[0]
		let indexInArchetype = -1

		// Binary search to find the component's index in the archetype's sorted list.
		let low = 1, high = count
		while (low <= high) {
			const mid = (low + high) >>> 1
			const midVal = componentIdArray[mid]
			if (midVal === typeID) {
				indexInArchetype = mid - 1
				break
			} else if (midVal < typeID) {
				low = mid + 1
			} else {
				high = mid - 1
			}
		}

		if (indexInArchetype !== -1) {
			this._updateArchetypeDirtyTick(chunkId, indexInArchetype, currentTick)
		}
	}

	addEntityFromBinarySoAPayload(archetype, entityId, binarySoAPayload, currentTick) {
		const chunkId = this._findOrCreateChunkId(archetype)
		const indexInChunk = this._addEntityToChunk(chunkId, entityId)
		entityStore.entityLocations[Number(entityId & 0xffffffffn)] = { archetypeId: archetype, chunkId, indexInChunk }

		const sourceView = new DataView(binarySoAPayload)
		let componentBaseOffset = 0

		const componentIdArray = entityStore.archetypeComponentTypeIDArrays[archetype]
		const count = componentIdArray[0]
		for (let i = 1; i <= count; i++) {
			const indexInArchetype = i - 1
			const typeID = componentIdArray[i]
			const info = Schema.componentInfo[typeID]
			const alignment = info.alignment
			if (alignment > 0 && componentBaseOffset % alignment !== 0) {
				componentBaseOffset += alignment - (componentBaseOffset % alignment)
			}

			this._writeComponentDataFromBuffer(chunkId, indexInChunk, typeID, sourceView, componentBaseOffset)
			componentBaseOffset += info.byteSize

			entityStore.chunkDirtyTicks[chunkId][typeID][indexInChunk] = currentTick
			this._updateArchetypeDirtyTick(chunkId, indexInArchetype, currentTick)
		}
	}

	_addIdenticalEntitiesBatch(archetype, entities, payload, currentTick) {
		const count = entities.length
		if (count === 0) return

		let entityCursor = 0

		while (entityCursor < count) {
			const chunkId = this._findOrCreateChunkId(archetype)

			const spaceInChunk = entityStore.chunkCapacities[chunkId] - entityStore.chunkSizes[chunkId]
			const entitiesToAddInChunk = Math.min(count - entityCursor, spaceInChunk)
			const startIndexInChunk = entityStore.chunkSizes[chunkId]
			const endIndexInChunk = startIndexInChunk + entitiesToAddInChunk

			const entitiesSlice = entities.slice(entityCursor, entityCursor + entitiesToAddInChunk)
			entityStore.chunkComponentData[chunkId].entities.set(entitiesSlice, startIndexInChunk)

			for (let i = 0; i < entitiesToAddInChunk; i++) {
				const entityId = entitiesSlice[i]
				entityStore.entityLocations[Number(entityId & 0xffffffffn)] = {
					archetypeId: archetype, // This is archetypeId
					chunkId,
					indexInChunk: startIndexInChunk + i,
				}
			}

			const aosView = new DataView(payload)
			let aosOffset = 0

			const componentIdArray = entityStore.archetypeComponentTypeIDArrays[archetype]
			const componentCount = componentIdArray[0]
			for (let j = 1; j <= componentCount; j++) {
				const indexInArchetype = j - 1
				const typeID = componentIdArray[j]
				const info = Schema.componentInfo[typeID]
				if (info.byteSize === 0) continue

				const destSoAArrays = entityStore.chunkComponentData[chunkId][typeID]

				// "Interleaved Strided Copy" - Loop per-property, not per-entity.
				for (const propKey of info.propertyKeys) {
					const propInfo = info.properties[propKey]
					const destArray = destSoAArrays[propKey]
					const propSize = propInfo.arrayConstructor.BYTES_PER_ELEMENT

					// Read single value for this property from AoS payload once.
					const valueToBlit = aosView[propInfo.readMethod](aosOffset, true)

					// Stamp value into SoA array for entire batch in this chunk.
					destArray.fill(valueToBlit, startIndexInChunk, endIndexInChunk)

					aosOffset += propSize
				}
				entityStore.chunkDirtyTicks[chunkId][typeID].fill(currentTick, startIndexInChunk, endIndexInChunk)
				this._updateArchetypeDirtyTick(chunkId, indexInArchetype, currentTick)
			}

			entityStore.chunkSizes[chunkId] += entitiesToAddInChunk
			entityCursor += entitiesToAddInChunk
		}
	}

	_getOrCreateCopyPlan(sourceArchetypeId, targetArchetypeId) {
		const sourceTransitions = entityStore.archetypeTransitions[sourceArchetypeId]
		if (sourceTransitions.add[targetArchetypeId]) {
			return sourceTransitions.add[targetArchetypeId]
		}

		const plan = {
			toCopy: [],
			toInitialize: [],
		}

		const targetComponentIdArray = entityStore.archetypeComponentTypeIDArrays[targetArchetypeId]
		if (!targetComponentIdArray) return plan

		const targetComponentCount = targetComponentIdArray[0]
		for (let i = 1; i <= targetComponentCount; i++) {
			const typeID = targetComponentIdArray[i]

			// Use the new, fast binary search `hasComponentType`
			if (this.hasComponentType(sourceArchetypeId, typeID)) {
				// Pre-calculate flattened list of properties to copy.
				for (const propKey of Schema.componentInfo[typeID].propertyKeys) {
					plan.toCopy.push({ typeID, propKey })
				}
			} else {
				plan.toInitialize.push(typeID)
			}
		}

		sourceTransitions.add[targetArchetypeId] = plan
		return plan
	}

	_addEntitiesByCopyingBatch(
		targetArchetype,
		sourceArchetype,
		sourceLocations,
		entityIds,
		componentsToAssign, // Map<typeId, { dataOffsets: number[], dataLengths: number[] }>
		reader,
		currentTick
	) {
		const count = entityIds.length
		if (count === 0) return

		const copyPlan = this._getOrCreateCopyPlan(sourceArchetype, targetArchetype)
		const newLocationsMap = new Map()
		let entityCursor = 0

		while (entityCursor < count) {
			const chunkId = this._findOrCreateChunkId(targetArchetype)

			const spaceInChunk = entityStore.chunkCapacities[chunkId] - entityStore.chunkSizes[chunkId]
			const entitiesToAddInChunk = Math.min(count - entityCursor, spaceInChunk)
			const startIndexInChunk = entityStore.chunkSizes[chunkId]

			// --- Batch Add Entities and Update Mappings ---
			for (let i = 0; i < entitiesToAddInChunk; i++) {
				const overallIndex = entityCursor + i
				const targetIndex = startIndexInChunk + i
				const entityId = entityIds[overallIndex]

				entityStore.chunkComponentData[chunkId].entities[targetIndex] = entityId
				const newLocation = { chunkId, indexInChunk: targetIndex }
				entityStore.entityLocations[Number(entityId & 0xffffffffn)] = { archetypeId: targetArchetype, ...newLocation }
				newLocationsMap.set(entityId, newLocation)
			}

			// --- Batch Copy Component Data (SoA style) ---
			// loop per-property, not per-entity.
			for (const { typeID, propKey } of copyPlan.toCopy) {
				const targetArray = entityStore.chunkComponentData[chunkId][typeID][propKey]
				const dirtyTicksArray = entityStore.chunkDirtyTicks[chunkId][typeID]

				for (let i = 0; i < entitiesToAddInChunk; i++) {
					const overallIndex = entityCursor + i
					const targetIndex = startIndexInChunk + i
					const { chunkId: sourceChunkId, indexInChunk: sourceIndex } = sourceLocations[overallIndex]
					const sourceArray = entityStore.chunkComponentData[sourceChunkId][typeID][propKey]
					targetArray[targetIndex] = sourceArray[sourceIndex]
					dirtyTicksArray[targetIndex] = currentTick
				}
			}

			// --- Batch Initialize New Components ---
			for (const typeID of copyPlan.toInitialize) {
				const payloadInfo = componentsToAssign.get(typeID)
				if (!payloadInfo) continue

				for (let i = 0; i < entitiesToAddInChunk; i++) {
					const overallIndex = entityCursor + i
					const destIndex = startIndexInChunk + i
					const sourceOffset = payloadInfo.dataOffsets[overallIndex]
					const sourceLength = payloadInfo.dataLengths[overallIndex]
					const sourceView = new DataView(reader.buffer, sourceOffset, sourceLength)
					this._writeComponentDataFromBuffer(chunkId, destIndex, typeID, sourceView, 0)
					entityStore.chunkDirtyTicks[chunkId][typeID][destIndex] = currentTick
				}
			}

			// --- Batch Update High-Water Marks ---
			const targetComponentIdArray = entityStore.archetypeComponentTypeIDArrays[targetArchetype]
			const targetComponentCount = targetComponentIdArray[0]
			const archetypeDirtyTicks = entityStore.chunkArchetypeDirtyTicks[chunkId]

			// Update all component high-water marks for this new chunk.
			for (let i = 1; i <= targetComponentCount; i++) {
				const indexInArchetype = i - 1
				this._updateArchetypeDirtyTick(chunkId, indexInArchetype, currentTick)
			}

			entityStore.chunkSizes[chunkId] += entitiesToAddInChunk
			entityCursor += entitiesToAddInChunk
		}
	}

	_removeEntitiesBatch(archetype, entityIds) {
		const removalsByChunk = new Map()
		const archetypeChunks = entityStore.archetypeChunks[archetype]

		const componentIdArray = entityStore.archetypeComponentTypeIDArrays[archetype]
		const componentCount = componentIdArray ? componentIdArray[0] : 0
		const componentTypeIDs = componentIdArray ? componentIdArray.slice(1) : []

		for (const entityId of entityIds) {
			const location = entityStore.entityLocations[Number(entityId & 0xffffffffn)]

			if (location) {
				const { chunkId, indexInChunk } = location
				if (!removalsByChunk.has(chunkId)) {
					removalsByChunk.set(chunkId, [])
				}
				removalsByChunk.get(chunkId).push(indexInChunk)
			}
		}

		for (const [chunkId, indicesToRemove] of removalsByChunk.entries()) {
			indicesToRemove.sort((a, b) => b - a)
			const swappedMappings = this._removeEntitiesFromChunk(chunkId, indicesToRemove, componentTypeIDs, componentCount)

			for (const [swappedEntityId, newIndex] of swappedMappings.entries()) {
				const swappedLocation = entityStore.entityLocations[Number(swappedEntityId & 0xffffffffn)] // This is entity index
				if (swappedLocation) swappedLocation.indexInChunk = newIndex
			}

			if (entityStore.chunkSizes[chunkId] === 0) {
				const chunkIndex = archetypeChunks.indexOf(chunkId)
				this._destroyChunk(chunkId, archetype, chunkIndex)
			}
		}
	}

	_removeEntitiesFromChunk(chunkId, sortedIndicesToRemove, componentTypeIDs, componentCount) {
		const numToRemove = sortedIndicesToRemove.length
		if (numToRemove === 0) return new Map()

		const swappedMappings = new Map()
		let lastIndex = entityStore.chunkSizes[chunkId] - 1

		for (const indexToRemove of sortedIndicesToRemove) {
			if (indexToRemove > lastIndex) continue

			const isLastElement = indexToRemove === lastIndex

			const chunkEntities = entityStore.chunkComponentData[chunkId].entities
			if (!isLastElement) {
				const swappedEntityId = chunkEntities[lastIndex]
				chunkEntities[indexToRemove] = swappedEntityId
				swappedMappings.set(swappedEntityId, indexToRemove)

				for (let i = 0; i < componentCount; i++) {
					const typeID = componentTypeIDs[i]
					const propArrays = entityStore.chunkComponentData[chunkId][typeID]
					for (const propKey in propArrays) {
						propArrays[propKey][indexToRemove] = propArrays[propKey][lastIndex]
					}
					entityStore.chunkDirtyTicks[chunkId][typeID][indexToRemove] =
						entityStore.chunkDirtyTicks[chunkId][typeID][lastIndex]
				}
			}
			lastIndex--
		}

		entityStore.chunkSizes[chunkId] -= numToRemove
		return swappedMappings
	}

	_createEntityId() {
		const index = entityStore.freeIndices.length > 0 ? entityStore.freeIndices.pop() : entityStore.nextEntityIndex++

		if (index >= entityStore.entityLocations.length) {
			const newLength = index + 1
			entityStore.generations.length = newLength
			entityStore.generations.fill(0, entityStore.entityLocations.length)
			entityStore.entityVersion.length = newLength
			entityStore.entityLocations.length = newLength
		}

		const generation = entityStore.generations[index]
		const entityId = (BigInt(generation) << 32n) | BigInt(index)
		entityStore.entityVersion[index] = entityId

		return entityId
	}

	_removeEntity(archetype, entityId, location) {
		if (!location) {
			return
		}

		const { chunkId, indexInChunk } = location
		const componentIdArray = entityStore.archetypeComponentTypeIDArrays[archetype]
		const componentCount = componentIdArray ? componentIdArray[0] : 0
		const componentTypeIDs = componentIdArray ? componentIdArray.slice(1) : []

		const swappedMappings = this._removeEntitiesFromChunk(chunkId, [indexInChunk], componentTypeIDs, componentCount)

		for (const [swappedEntityId, newIndex] of swappedMappings.entries()) {
			const swappedLocation = entityStore.entityLocations[Number(swappedEntityId & 0xffffffffn)] // entity index
			if (swappedLocation) swappedLocation.indexInChunk = newIndex
		}

		if (entityStore.chunkSizes[chunkId] === 0) {
			const archetypeChunks = entityStore.archetypeChunks[archetype]
			this._destroyChunk(chunkId, archetype, archetypeChunks.indexOf(chunkId))
		}
	}

	_addEntityToChunk(chunkId, entityId) {
		const index = entityStore.chunkSizes[chunkId]
		entityStore.chunkComponentData[chunkId].entities[index] = entityId
		entityStore.chunkSizes[chunkId]++
		return index
	}

	/**
	 * Finds a chunk within an archetype that has free space, or creates a new one if necessary.
	 * This is a critical path for entity creation. See `EntityManager.md` for scalability notes.
	 * @param {number} archetypeId The ID of the archetype to find a chunk in.
	 * @returns {number | null} The ID of a chunk with space, or null if the archetype is invalid.
	 * @private
	 */
	_findOrCreateChunkId(archetypeId) {
		const archetypeChunks = entityStore.archetypeChunks[archetypeId]
		if (!archetypeChunks) return null // Archetype might not exist yet or has been cleared
		const lastNonFullChunkIndex = entityStore.archetypeLastNonFullChunk[archetypeId] || 0

		// Start search from last known non-full chunk
		if (archetypeChunks.length > 0) {
			for (let i = 0; i < archetypeChunks.length; i++) {
				const chunkArrayIndex = (lastNonFullChunkIndex + i) % archetypeChunks.length
				const chunkId = archetypeChunks[chunkArrayIndex]
				if (chunkId !== undefined && entityStore.chunkSizes[chunkId] < entityStore.chunkCapacities[chunkId]) {
					entityStore.archetypeLastNonFullChunk[archetypeId] = chunkArrayIndex
					return chunkId
				}
			}
		}

		// --- Chunk Pooling Logic ---
		// If no non-full chunk is found, try to recycle one from the free list.
		const bytesPerEntity = this.getBytesPerEntityInArchetype(archetypeId)

		if (entityStore.freeChunkIds.length > 0) {
			// For simplicity, we'll just pop from the end. A more advanced pool might
			// have separate lists for different size classes.
			const recycledChunkId = entityStore.freeChunkIds.pop()

			// Re-initialize the recycled chunk.
			return this._reinitializeChunk(recycledChunkId, archetypeId)
		}

		// If no non-full chunk is found and the pool is empty, create a new one.
		const newChunkId = entityStore.nextChunkId++
		if (newChunkId >= MAX_CHUNKS) {
			throw new Error(`EntityManager: Maximum number of chunks (${MAX_CHUNKS}) reached.`)
		}

		// --- Dynamic Chunk Capacity Calculation ---
		const calculatedCapacity =
			bytesPerEntity > 0 ? Math.floor(TARGET_CHUNK_SIZE_BYTES / bytesPerEntity) : MIN_CHUNK_CAPACITY
		const capacity = Math.max(MIN_CHUNK_CAPACITY, calculatedCapacity)

		entityStore.chunkArchetypeIds[newChunkId] = archetypeId
		entityStore.chunkSizes[newChunkId] = 0
		entityStore.chunkCapacities[newChunkId] = capacity

		// Initialize data structures for each component in the archetype
		const componentIdArray = entityStore.archetypeComponentTypeIDArrays[archetypeId]
		const componentCount = componentIdArray[0]

		// Allocate the new per-component-type dirty tick buffer for this chunk.
		const archetypeTicksBuffer = new SharedArrayBuffer(componentCount * Uint32Array.BYTES_PER_ELEMENT)
		entityStore.chunkArchetypeDirtyTicks[newChunkId] = new Uint32Array(archetypeTicksBuffer)
		// Initialize all ticks to 0.
		entityStore.chunkArchetypeDirtyTicks[newChunkId].fill(0)


		entityStore.chunkComponentData[newChunkId] = {
			entities: new BigUint64Array(new SharedArrayBuffer(capacity * BigUint64Array.BYTES_PER_ELEMENT)),
		}
		entityStore.chunkDirtyTicks[newChunkId] = {}

		for (let i = 1; i <= componentCount; i++) {
			const typeID = componentIdArray[i]
			const info = Schema.componentInfo[typeID]
			const propArrays = {}
			for (const propKey of info.propertyKeys) {
				const constructor = info.properties[propKey].arrayConstructor
				const buffer = new SharedArrayBuffer(capacity * constructor.BYTES_PER_ELEMENT)
				propArrays[propKey] = new constructor(buffer)
			}
			entityStore.chunkComponentData[newChunkId][typeID] = propArrays
			entityStore.chunkDirtyTicks[newChunkId][typeID] = new Uint32Array(
				new SharedArrayBuffer(capacity * Uint32Array.BYTES_PER_ELEMENT)
			)
		}

		archetypeChunks.push(newChunkId)
		this.queryManager.registerChunk(archetypeId, newChunkId)
		entityStore.archetypeLastNonFullChunk[archetypeId] = archetypeChunks.length - 1

		// Track this new chunk for delta-syncing.
		this.newlyCreatedChunks.push(newChunkId)
		return newChunkId
	}

	/**
	 * Re-initializes a recycled chunk for a new archetype.
	 * @param {number} chunkId The ID of the chunk to re-initialize.
	 * @param {number} archetypeId The new archetype ID for the chunk.
	 * @returns {number} The re-initialized chunk ID.
	 * @private
	 */
	_reinitializeChunk(chunkId, archetypeId) {
		// This is an intelligent re-initialization. Instead of re-allocating all buffers,
		// we reuse the existing ones and only add/remove what's necessary.

		const capacity = entityStore.chunkCapacities[chunkId]
		const oldArchetypeId = entityStore.chunkArchetypeIds[chunkId] // Get the archetype it USED to be.

		// Reset the chunk's core metadata.
		entityStore.chunkArchetypeIds[chunkId] = archetypeId
		entityStore.chunkSizes[chunkId] = 0

		// Get component lists for old and new archetypes.
		const oldComponentIds = new Set(this.getComponentTypeIDsForArchetype(oldArchetypeId))
		const newComponentIds = this.getComponentTypeIDsForArchetype(archetypeId)

		// 1. Remove references to components that are no longer in the archetype.
		// This allows their buffers to be garbage collected.
		for (const typeID of oldComponentIds) {
			if (!this.hasComponentType(archetypeId, typeID)) {
				entityStore.chunkComponentData[chunkId][typeID] = undefined
				// The per-entity dirty tick array can be cleared.
				entityStore.chunkDirtyTicks[chunkId][typeID] = undefined
			}
		}
		// The chunkArchetypeDirtyTicks buffer is now the wrong size. We must de-reference it
		// and create a new one for the new archetype.
		entityStore.chunkArchetypeDirtyTicks[chunkId] = undefined
		const newComponentCount = this.getComponentTypeIDsForArchetype(archetypeId).length
		const archetypeTicksBuffer = new SharedArrayBuffer(newComponentCount * Uint32Array.BYTES_PER_ELEMENT)
		entityStore.chunkArchetypeDirtyTicks[chunkId] = new Uint32Array(archetypeTicksBuffer)

		// 2. Add buffers for components that are new to this archetype.
		for (const typeID of newComponentIds) {
			if (!oldComponentIds.has(typeID)) {
				// This component is new, so we must allocate buffers for it.
				const info = Schema.componentInfo[typeID]
				const propArrays = {}
				for (const propKey of info.propertyKeys) {
					const constructor = info.properties[propKey].arrayConstructor
					const buffer = new SharedArrayBuffer(capacity * constructor.BYTES_PER_ELEMENT)
					propArrays[propKey] = new constructor(buffer)
				}
				entityStore.chunkComponentData[chunkId][typeID] = propArrays
				entityStore.chunkDirtyTicks[chunkId][typeID] = new Uint32Array(
					new SharedArrayBuffer(capacity * Uint32Array.BYTES_PER_ELEMENT)
				)
			}
		}

		// Add the re-purposed chunk to its new archetype's list.
		const archetypeChunks = entityStore.archetypeChunks[archetypeId]
		archetypeChunks.push(chunkId)
		this.queryManager.registerChunk(archetypeId, chunkId)
		entityStore.archetypeLastNonFullChunk[archetypeId] = archetypeChunks.length - 1

		this.newlyCreatedChunks.push(chunkId)
		return chunkId
	}
	/**
	 * Internal helper to mark a chunk as destroyed and ready for cleanup/pooling.
	 * @param {number} chunkId The ID of the chunk to destroy.
	 * @param {number} archetypeId The archetype the chunk belonged to.
	 * @param {number} indexInArchetype The chunk's index in the archetype's chunk list.
	 * @private
	 */
	_destroyChunk(chunkId, archetypeId, indexInArchetype) {
		if (indexInArchetype > -1) {
			const archetypeChunks = entityStore.archetypeChunks[archetypeId]
			archetypeChunks.splice(indexInArchetype, 1)
			if (entityStore.archetypeLastNonFullChunk[archetypeId] >= indexInArchetype) {
				entityStore.archetypeLastNonFullChunk[archetypeId]--
			}
		}

		this.queryManager.unregisterChunk(archetypeId, chunkId)

		// Mark the chunk as unowned and ready for recycling.
		// We DO NOT reset the archetypeId here. We need it for the intelligent
		// re-initialization logic above. It will be overwritten when reused.
		// entityStore.chunkArchetypeIds[chunkId] = 0
		entityStore.chunkSizes[chunkId] = 0 // Should already be 0, but good to be explicit.
		// We don't clear chunkComponentData or chunkDirtyTicks here, as they will be overwritten
		// on re-initialization. However, we should clear the archetype-level ticks.
		entityStore.chunkArchetypeDirtyTicks[chunkId] = undefined
		entityStore.freeChunkIds.push(chunkId)

		this.destroyedChunks.push(chunkId)
	}

	_writeComponentDataFromBuffer(chunkId, indexInChunk, typeID, sourceView, componentBaseOffset) {
		const info = Schema.componentInfo[typeID]
		const destSoaArrays = entityStore.chunkComponentData[chunkId][typeID]

		// Iterate through flattened properties to write data.
		for (const propKey of info.propertyKeys) {
			const propInfo = info.properties[propKey]
			if (!propInfo) continue

			const readOffset = componentBaseOffset + propInfo.offset
			let value
			// if/else is necessary because DataView's BigInt methods have a different signature.
			if (propInfo.arrayConstructor.name.startsWith('Big')) {
				value = sourceView[propInfo.readMethod](readOffset, true) // For getBigInt64/getBigUint64
			} else {
				value = sourceView[propInfo.readMethod](readOffset, true) // For getFloat32, getInt32 etc.
			}

			destSoaArrays[propKey][indexInChunk] = value
		}
	}

	/**
	 * Atomically updates the per-component-type high-water mark for a given chunk.
	 * @param {number} chunkId The chunk to update.
	 * @param {number} indexInArchetype The 0-based index of the component within its archetype's sorted list.
	 * @param {number} tick The current game tick.
	 * @private
	 */
	_updateArchetypeDirtyTick(chunkId, indexInArchetype, tick) {
		const archetypeDirtyTicks = entityStore.chunkArchetypeDirtyTicks[chunkId]
		if (!archetypeDirtyTicks) return

		let oldValue = Atomics.load(archetypeDirtyTicks, indexInArchetype)
		while (tick > oldValue) {
			const result = Atomics.compareExchange(archetypeDirtyTicks, indexInArchetype, oldValue, tick)
			if (result === oldValue) break
			oldValue = result
		}
	}

	/**
	 * Calculates the total number of bytes required to store one entity in a given archetype.
	 * This includes the size of all its components plus the 8-byte entity ID.
	 * @param {number} archetypeId - The ID of the archetype.
	 * @returns {number} The size in bytes.
	 */
	getBytesPerEntityInArchetype(archetypeId) {
		const componentIdArray = this.getComponentTypeIDsForArchetype(archetypeId)
		if (!componentIdArray) return 0

		// Start with the size of the entity ID itself (BigUint64)
		let totalBytes = BigUint64Array.BYTES_PER_ELEMENT

		for (const typeID of componentIdArray) {
			const info = Schema.componentInfo[typeID]
			if (info) totalBytes += info.byteSize
		}

		return totalBytes
	}
}
