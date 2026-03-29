import * as Schema from '../ComponentManager/ComponentSchema.js'
const { SharedArchetypeHashMap } = await import(`@core/DataStructures/SharedArchetypeHashMap.js`)
const { h64Raw } = await xxhash()
/**
 * Manages all entities, archetypes, and their component data.
 * This class is the heart of the ECS, owning the core data structures that track every entity.
 * It provides methods for all structural changes: creating/destroying entities and adding/removing components.
 *
 * --- `entityStore` Breakdown ---
 *
 * 1.  **Entity Management & Generational IDs:**
 *     -   To solve the "stale ID" problem, the engine uses **Generational Entity IDs**. Each ID is a `BigInt`
 *         (64-bit unsigned integer) composed of an index, a generation counter, and a placeholder flag.
 *
 *     -   **ID Layout (64 bits):**
 *         | Part        | Bits    | Description                                             |
 *         |-------------|---------|---------------------------------------------------------|
 *         | Placeholder | 1 bit   | (MSB) A flag to mark the ID as a temporary placeholder. |
 *         | Generation  | 31 bits | A counter that increments each time an index is reused. |
 *         | Index       | 32 bits | A stable index into internal entity arrays.             |
 *
 *     -   This ensures that recycled entity IDs do not accidentally refer to new entities.
 *
 * 2.  **Archetype Management:**
 *     -   An archetype represents a unique combination of components.
 *     -   `archetypeComponentTypeIDArrays`: A shareable container that allows workers to safely discover
 *         the structure of new archetypes at runtime.
 *
 * 3.  **Chunk & Component Data:**
 *     -   Component data is stored in `Chunks` using a **Structure of Arrays (SoA)** layout.
 *     -   Each chunk's data is backed by `SharedArrayBuffer`, enabling zero-copy data access for workers.
 *     -   The engine uses a "Per-Property SoA" model (separate buffers for each component property), which is
 *         optimized for fast structural changes (e.g., adding/removing components) and efficient memory pooling.
 */

export const MAX_ARCHETYPES = 4096 // Maximum number of unique archetypes
export const MAX_CHUNKS = 65536 // Maximum number of chunks
export const MAX_COMPONENTS = 256 // A practical limit for component types
export const MASK_PARTS = Math.ceil(MAX_COMPONENTS / 64) // = 4 for 256 components
const INITIAL_ENTITY_CAPACITY = 8192 // Initial capacity for entity-indexed arrays

const TARGET_CHUNK_SIZE_BYTES = 16384 // 16KB

const CACHE_LINE_SIZE = 64 // Common CPU cache line size in bytes
const CACHE_LINE_SIZE_IN_U32 = CACHE_LINE_SIZE / Uint32Array.BYTES_PER_ELEMENT

const MIN_CHUNK_CAPACITY = 16

// Using 0 as a sentinel for "no chunk" or "null pointer" in linked lists.
export const NULL_CHUNK_ID = 0

const ARCHETYPE_STORE_PAGE_SIZE_IN_BYTES = 4096 // 4KB page for component IDs
const ARCHETYPE_STORE_PAGE_SIZE_IN_U16 = ARCHETYPE_STORE_PAGE_SIZE_IN_BYTES / Uint16Array.BYTES_PER_ELEMENT

export const entityStore = {
	// --- Entity Management ---
	entityCapacity: INITIAL_ENTITY_CAPACITY,
	entityVersion: [],
	// A packed array storing [ (archetypeId << 16 | chunkId), indexInChunk ] per entity
	entityLocations: new Uint32Array(new SharedArrayBuffer(INITIAL_ENTITY_CAPACITY * 2 * Uint32Array.BYTES_PER_ELEMENT)),
	// Generations are plain numbers, not bigints.
	generations: new Array(INITIAL_ENTITY_CAPACITY).fill(0),
	freeIndices: [],
	nextEntityIndex: 1,

	// --- Archetype Management (Currently Main-thread only structures) ---
	archetypeLookup: null, // Will be initialized as SharedArchetypeHashMap
	archetypeTransitions: new Array(MAX_ARCHETYPES),
	archetypeComponentIndexMaps: new Array(MAX_ARCHETYPES),
	archetypeByteSizes: new Uint32Array(new SharedArrayBuffer(MAX_ARCHETYPES * Uint32Array.BYTES_PER_ELEMENT)),
	// Paged buffer for component IDs. The array of pages is main-thread only.
	// Workers receive the SABs inside and sync new pages.
	packedComponentIdPages: [],
	nextPackedComponentIdIndex: 0,

	// --- Archetype Store (Shared) ---
	nextArchetypeId: new Uint32Array(new SharedArrayBuffer(4)), // Atomic counter
	archetypeMasks: new BigUint64Array(
		new SharedArrayBuffer(MAX_ARCHETYPES * MASK_PARTS * BigUint64Array.BYTES_PER_ELEMENT),
	),
	archetypeComponentCounts: new Uint16Array(new SharedArrayBuffer(MAX_ARCHETYPES * Uint16Array.BYTES_PER_ELEMENT)),
	archetypeChunkCounts: new Uint16Array(new SharedArrayBuffer(MAX_ARCHETYPES * Uint16Array.BYTES_PER_ELEMENT)),
	archetypeHeadChunkIds: new Uint16Array(new SharedArrayBuffer(MAX_ARCHETYPES * Uint16Array.BYTES_PER_ELEMENT)),
	archetypeTailChunkIds: new Uint16Array(new SharedArrayBuffer(MAX_ARCHETYPES * Uint16Array.BYTES_PER_ELEMENT)),
	archetypeLastNonFullChunkId: new Uint16Array(new SharedArrayBuffer(MAX_ARCHETYPES * Uint16Array.BYTES_PER_ELEMENT)),
	archetypeComponentListStartIndices: new Uint32Array(
		new SharedArrayBuffer(MAX_ARCHETYPES * Uint32Array.BYTES_PER_ELEMENT),
	),

	// --- Chunk Management ---
	nextChunkId: 1, // Start from 1 so 0 can be NULL_CHUNK_ID
	freeChunkIds: [],
	chunkArchetypeIds: new Uint16Array(new SharedArrayBuffer(MAX_CHUNKS * Uint16Array.BYTES_PER_ELEMENT)),
	chunkSizes: new Uint16Array(new SharedArrayBuffer(MAX_CHUNKS * Uint16Array.BYTES_PER_ELEMENT)),
	chunkCapacities: new Uint16Array(new SharedArrayBuffer(MAX_CHUNKS * Uint16Array.BYTES_PER_ELEMENT)),
	// Intrusive linked list pointers for chunks (shared)
	chunkPrevInArchetype: new Uint16Array(new SharedArrayBuffer(MAX_CHUNKS * Uint16Array.BYTES_PER_ELEMENT)),
	chunkNextInArchetype: new Uint16Array(new SharedArrayBuffer(MAX_CHUNKS * Uint16Array.BYTES_PER_ELEMENT)),

	// These are now pre-allocated to ensure workers can see new chunks added at runtime.
	// They are not SharedArrayBuffers themselves, but they hold SABs.
	// The array itself is what needs to be shared in structure.
	chunkMetadata: new Array(MAX_CHUNKS),
	chunkComponentData: new Array(MAX_CHUNKS),
	chunkDirtyTicks: new Array(MAX_CHUNKS),
	chunkArchetypeDirtyTicks: new Array(MAX_CHUNKS),
	chunkAddedComponentMasks: new Array(MAX_CHUNKS),
	chunkRemovedComponentMasks: new Array(MAX_CHUNKS),
}

// Initialize atomic nextArchetypeId to 0. The first archetype will be ID 0.
Atomics.store(entityStore.nextArchetypeId, 0, 0)

export class EntityManager {
	constructor() {
		// --- Manager References ---
		this.queryManager = null
		this.componentManager = null
		this.systemManager = null
		this.prefabManager = null
		this.workerManager = null

		// Tracks chunk IDs created within a single frame for delta-syncing to workers.
		this.newlyCreatedChunks = []
		this.destroyedChunks = []
		this.newlyCreatedArchetypePages = []
	}

	async init(ecs) {
		this.queryManager = ecs.queryManager
		this.componentManager = ecs.componentManager
		this.systemManager = ecs.systemManager
		this.prefabManager = ecs.prefabManager
		this.workerManager = ecs.workerManager

		// Initialize the shared archetype map
		entityStore.archetypeLookup = new SharedArchetypeHashMap(
			{
				initialCapacity: 512, // A reasonable starting capacity. If a resize ever triggers, the capacity will double.
				workerManager: this.workerManager,
			},
			h64Raw,
		)

		// Initialize the first page for the packed component ID buffer.
		const initialPage = new Uint16Array(new SharedArrayBuffer(ARCHETYPE_STORE_PAGE_SIZE_IN_BYTES))
		entityStore.packedComponentIdPages.push(initialPage)
		this.newlyCreatedArchetypePages.push(initialPage.buffer)

		// Register all shared data with the sharedResourceRegistry for worker initialization.
		this.workerManager.addInitialResource('sharedData', this.getSharedData())

		// Pre-gather all existing chunks for the initial worker sync.
		// This is now less critical as workers can sync deltas, but good for initial state.
		const initialChunks = {}
		for (let i = 0; i < entityStore.nextChunkId; i++) {
			// Only include active chunks, not ones that have been freed.
			if (entityStore.chunkArchetypeIds[i]) {
				initialChunks[i] = {
					data: this.getSharedComponentData(i),
					archetypeTicks: entityStore.chunkArchetypeDirtyTicks[i],
					metadata: entityStore.chunkMetadata[i],
				}
			}
		}
		this.workerManager.addInitialResource('initialChunks', initialChunks)
	}

	/**
	 * Gathers all SharedArrayBuffers and metadata required for workers to reconstruct
	 * a view of the world state. This is called once during worker initialization.
	 * @returns {object} A serializable object containing all shared data.
	 */
	getSharedData() {
		return {
			// --- Archetype Store ---
			entityLocations: entityStore.entityLocations.buffer,
			nextArchetypeId: entityStore.nextArchetypeId.buffer,
			archetypeMasks: entityStore.archetypeMasks.buffer,
			archetypeComponentCounts: entityStore.archetypeComponentCounts.buffer,
			archetypeChunkCounts: entityStore.archetypeChunkCounts.buffer,
			archetypeHeadChunkIds: entityStore.archetypeHeadChunkIds.buffer,
			archetypeTailChunkIds: entityStore.archetypeTailChunkIds.buffer,
			archetypeLastNonFullChunkId: entityStore.archetypeLastNonFullChunkId.buffer,
			archetypeComponentListStartIndices: entityStore.archetypeComponentListStartIndices.buffer,
			archetypeByteSizes: entityStore.archetypeByteSizes.buffer,
			packedComponentIdPageSABs: entityStore.packedComponentIdPages.map(p => p.buffer),
			archetypeMapBuffer: entityStore.archetypeLookup.buffer,

			// --- Chunk Metadata ---
			chunkArchetypeIds: entityStore.chunkArchetypeIds.buffer,
			chunkSizes: entityStore.chunkSizes.buffer,
			chunkCapacities: entityStore.chunkCapacities.buffer,
			chunkPrevInArchetype: entityStore.chunkPrevInArchetype.buffer,
			chunkNextInArchetype: entityStore.chunkNextInArchetype.buffer,

			// --- Shared Data Structures ---
			chunkArchetypeDirtyTicks: entityStore.chunkArchetypeDirtyTicks,
			chunkMetadata: entityStore.chunkMetadata,
			chunkAddedComponentMasks: entityStore.chunkAddedComponentMasks,
			chunkRemovedComponentMasks: entityStore.chunkRemovedComponentMasks,

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
		let newChunks = null
		if (this.newlyCreatedChunks.length > 0) {
			newChunks = {}
			for (const chunkId of this.newlyCreatedChunks) {
				newChunks[chunkId] = {
					data: entityStore.chunkComponentData[chunkId],
					archetypeTicks: entityStore.chunkArchetypeDirtyTicks[chunkId],
					metadata: entityStore.chunkMetadata[chunkId],
					addedMasks: entityStore.chunkAddedComponentMasks[chunkId],
					removedMasks: entityStore.chunkRemovedComponentMasks[chunkId],
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

		return { newChunks, destroyedChunks }
	}

	getAndClearArchetypePageDeltas() {
		if (this.newlyCreatedArchetypePages.length > 0) {
			const pages = [...this.newlyCreatedArchetypePages]
			this.newlyCreatedArchetypePages.length = 0
			return pages
		}
		return null
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
		// Allow pre-supplying entity IDs for single creation path
		const useSuppliedIds = Array.isArray(arguments[4]) && arguments[4].length === count
		if (!useSuppliedIds) {
			for (let i = 0; i < count; i++) {
				entityIDs.push(this._createEntityId())
			}
		}

		this._addIdenticalEntitiesBatch(archetypeId, useSuppliedIds ? arguments[4] : entityIDs, payload, currentTick)

		return entityIDs
	}

	/**
	 * Creates a single entity from a pre-compiled binary AoS payload.
	 * This is the internal "fast path" for single entity creation.
	 * @param {number} archetypeId target archetype for entity.
	 * @param {ArrayBuffer} binaryAosPayload - The binary AoS-structured payload data from `compile`.
	 * @param {number} currentTick current game tick.
	 */
	createEntityFromAosPayload(archetypeId, binaryAosPayload, currentTick) {
		if (archetypeId === undefined) return
		const entityID = this._createEntityId() // This is now an array of one
		this.createIdenticalEntitiesInArchetype(archetypeId, binaryAosPayload, 1, currentTick, [entityID])
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
					componentTypeId,
				)}.`,
			)
			return false
		}
		const sourceArchetypeMask = entityStore.archetypeMasks.subarray(
			sourceArchetypeId * MASK_PARTS,
			(sourceArchetypeId + 1) * MASK_PARTS,
		)
		const targetArchetypeMask = new BigUint64Array(sourceArchetypeMask) // Clone
		if (componentTypeId >= MAX_COMPONENTS) {
			throw new Error(`Component type ID ${componentTypeId} exceeds MAX_COMPONENTS (${MAX_COMPONENTS}).`)
		}
		const partIndex = Math.floor(componentTypeId / 64)
		const bitInPart = componentTypeId % 64
		targetArchetypeMask[partIndex] |= 1n << BigInt(bitInPart)
		const targetArchetypeId = this.getArchetypeByMask(targetArchetypeMask)

		const componentsToAssign = new Map([[componentTypeId, data]])

		return this._moveEntityToNewArchetype(
			entityId,
			sourceArchetypeId,
			targetArchetypeId,
			componentsToAssign,
			currentTick,
		)
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
		const sourceArchetypeMask = entityStore.archetypeMasks.subarray(
			sourceArchetypeId * MASK_PARTS,
			(sourceArchetypeId + 1) * MASK_PARTS,
		)
		const targetArchetypeMask = new BigUint64Array(sourceArchetypeMask) // Clone
		if (componentTypeId >= MAX_COMPONENTS) {
			// This case is handled by hasComponentType, but good to be safe.
			return false
		}
		const partIndex = Math.floor(componentTypeId / 64)
		const bitInPart = componentTypeId % 64
		targetArchetypeMask[partIndex] &= ~(1n << BigInt(bitInPart))
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
		const archetypeId = this.getArchetypeForEntity(entityID)

		// Only try to get location and remove from chunk if the entity has an archetype.
		if (archetypeId !== undefined) {
			const location = this.getEntityLocation(entityID)
			if (location) this._removeEntity(archetypeId, entityID, location)
		}
		entityStore.entityVersion[index] = undefined
		// Clear the location data
		entityStore.entityLocations[index * 2] = 0
		entityStore.entityLocations[index * 2 + 1] = 0
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
		if (!entityIDs || entityIDs.size === 0) return true;

		const removalsByChunk = new Map(); // Map<chunkId, { archetypeId: number, indices: number[], entityIds: bigint[] }>

		// --- Pass 1: Gather and group all entities to be removed by their chunk ---
		for (const entityId of entityIDs) {
			if (!this.isEntityActive(entityId)) continue;

			const index = Number(entityId & 0xffffffffn);
			const packed1 = entityStore.entityLocations[index * 2];
			const chunkId = packed1 & 0xffff;

			if (chunkId !== NULL_CHUNK_ID) {
				const archetypeId = packed1 >> 16;
				const indexInChunk = entityStore.entityLocations[index * 2 + 1];
				if (!removalsByChunk.has(chunkId)) {
					removalsByChunk.set(chunkId, { archetypeId, indices: [], entityIds: [] });
				}
				const batch = removalsByChunk.get(chunkId);
				batch.indices.push(indexInChunk);
				batch.entityIds.push(entityId);
			} else {
				// Handle entities that exist but have no components (and thus no location).
				entityStore.freeIndices.push(index);
				entityStore.generations[index]++;
				entityStore.entityVersion[index] = undefined;
				entityStore.entityLocations[index * 2] = 0;
				entityStore.entityLocations[index * 2 + 1] = 0;
			}
		}

		// --- Pass 2: Perform batched removals chunk by chunk ---
		for (const [chunkId, batch] of removalsByChunk.entries()) {
			const { archetypeId, indices, entityIds } = batch;
			const componentTypeIDs = this.getComponentTypeIDsForArchetype(archetypeId);
			const componentCount = componentTypeIDs.length;
			const oldSize = entityStore.chunkSizes[chunkId];

			// Sort indices descending for safe swap-and-pop.
			indices.sort((a, b) => b - a);
			const swappedMappings = this._removeEntitiesFromChunk(chunkId, indices, componentTypeIDs, componentCount);

			// Update locations for any entities that were swapped.
			for (const [swappedEntityId, newIndex] of swappedMappings.entries()) {
				const swappedEntityIndex = Number(swappedEntityId & 0xffffffffn);
				entityStore.entityLocations[swappedEntityIndex * 2 + 1] = newIndex;
			}

			// Proactively update the non-full chunk pointer or destroy the chunk if it's now empty.
			if (entityStore.chunkCapacities[chunkId] === oldSize && entityStore.chunkSizes[chunkId] < oldSize) {
				entityStore.archetypeLastNonFullChunkId[archetypeId] = chunkId;
			} else if (entityStore.chunkSizes[chunkId] === 0) {
				this._destroyChunk(chunkId, archetypeId);
			}

			// Invalidate all destroyed entity IDs from this chunk's batch.
			for (const entityId of entityIds) {
				const index = Number(entityId & 0xffffffffn);
				entityStore.freeIndices.push(index);
				entityStore.generations[index]++;
				entityStore.entityVersion[index] = undefined;
				entityStore.entityLocations[index * 2] = 0;
				entityStore.entityLocations[index * 2 + 1] = 0;
			}
		}

		return true;
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
		const archetypeId = entityStore.chunkArchetypeIds[chunkId]

		const entitiesToDestroy = entityStore.chunkComponentData[chunkId].entities

		// 1. "Mark" Phase: Invalidate all entities in the central registry.
		for (let i = 0; i < size; i++) {
			const entityId = entitiesToDestroy[i]
			const index = Number(entityId & 0xffffffffn)
			entityStore.generations[index]++ // Increment generation to invalidate old IDs.
			entityStore.entityLocations[index * 2] = 0
			entityStore.entityLocations[index * 2 + 1] = 0
			entityStore.entityVersion[index] = undefined
			entityStore.freeIndices.push(index) // Recycle the index.
		}

		// 2. "Sweep" Phase: The chunk is now empty. Instead of just setting its size to 0,
		// we must call the full destruction logic to unlink it from queries and add it to the free pool.
		// This makes this "fast path" consistent with the regular entity destruction path.
		entityStore.chunkSizes[chunkId] = 0
		this._destroyChunk(chunkId, archetypeId)
	}

	destroyAllEntities() {
		// This is a full reset. We can safely clear everything.
		this.clearAllArchetypes() // Removes all chunks
		this.clearAll() // Resets all entity-related arrays and counters

		// Also reset chunk state for true test isolation. This prevents chunks freed
		// in one test from being recycled in another, which could cause capacity mismatches.
		entityStore.nextChunkId = 1
		entityStore.freeChunkIds.length = 0
		// Notify the query manager that all archetypes are gone so it can clear its queries.

		this.queryManager.unregisterAllArchetypes()
	}

	isEntityActive(entityID) {
		if (!entityID || typeof entityID !== 'bigint') return false
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
		const packed = entityStore.entityLocations[index * 2]
		return packed > 0 ? packed >> 16 : undefined
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
		const sourceLocation = this.getEntityLocation(entityId)
		if (!sourceLocation) return false

		const { chunkId: sourceChunkId, indexInChunk: sourceIndex } = sourceLocation

		// 1. Allocate space in target archetype and update entity's primary records.
		const targetChunkId = this._findOrCreateChunkId(targetArchetypeId)
		const targetIndex = this._addEntityToChunk(targetChunkId, entityId)
		const packed = (targetArchetypeId << 16) | targetChunkId
		entityStore.entityLocations[entityIndex * 2] = packed
		entityStore.entityLocations[entityIndex * 2 + 1] = targetIndex

		// Log the structural change for reactive queries.
		const sourceMask = entityStore.archetypeMasks.subarray(
			sourceArchetypeId * MASK_PARTS,
			(sourceArchetypeId + 1) * MASK_PARTS,
		)
		const targetMask = entityStore.archetypeMasks.subarray(
			targetArchetypeId * MASK_PARTS,
			(targetArchetypeId + 1) * MASK_PARTS,
		)
		const tickSlot = currentTick % Schema.DIRTY_HISTORY_LENGTH
		const addedMasksRing = entityStore.chunkAddedComponentMasks[targetChunkId]
		const removedMasksRing = entityStore.chunkRemovedComponentMasks[targetChunkId]

		if (addedMasksRing && removedMasksRing) {
			for (let i = 0; i < MASK_PARTS; i++) {
				const added = targetMask[i] & ~sourceMask[i]
				const removed = sourceMask[i] & ~targetMask[i]
				const slot = tickSlot * MASK_PARTS + i
				if (added > 0n) Atomics.or(addedMasksRing, slot, added)
				if (removed > 0n) Atomics.or(removedMasksRing, slot, removed)
			}
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
			const dataView = new DataView(data);
			this._writeComponentDataFromBuffer(targetChunkId, targetIndex, typeID, dataView, 0);
		}

		// 4. Mark only the newly added components as dirty for the current tick.
		const targetComponentIdArray = this.getComponentTypeIDsForArchetype(targetArchetypeId) // Needed for index lookup
		const componentIndexMap = new Map()
		for (let i = 0; i < targetComponentIdArray.length; i++) {
			componentIndexMap.set(targetComponentIdArray[i], i)
		}

		for (const typeID of componentsToAssign.keys()) {
			const indexInArchetype = componentIndexMap.get(typeID)
			if (indexInArchetype !== undefined) {
				this._updateArchetypeDirtyTick(targetChunkId, indexInArchetype, currentTick)
			}
		}

		// 4. Remove entity from its source chunk (using swap-and-pop).
		this._removeEntity(sourceArchetypeId, entityId, sourceLocation)

		return true
	}

	getArchetype(componentTypeIDs) {
		const sortedTypeIDs = [...componentTypeIDs].sort((a, b) => a - b)
		const archetypeMask = this.generateArchetypeMask(sortedTypeIDs)
		return this.getArchetypeByMask(archetypeMask, sortedTypeIDs)
	}

	getArchetypeByMask(archetypeMask, sortedTypeIDs) {
		const existingId = entityStore.archetypeLookup.lookup(archetypeMask)
		if (existingId !== undefined) {
			return existingId
		}

		const id = Atomics.add(entityStore.nextArchetypeId, 0, 1)
		if (id >= MAX_ARCHETYPES) {
			throw new Error(`EntityManager: Maximum number of archetypes (${MAX_ARCHETYPES}) reached.`)
		}

		if (!sortedTypeIDs) {
			sortedTypeIDs = this.getComponentTypesFromMask(archetypeMask)
		}

		// --- Write to Shared Archetype Store ---
		entityStore.archetypeMasks.set(archetypeMask, id * MASK_PARTS)
		entityStore.archetypeHeadChunkIds[id] = NULL_CHUNK_ID
		entityStore.archetypeTailChunkIds[id] = NULL_CHUNK_ID
		entityStore.archetypeLastNonFullChunkId[id] = NULL_CHUNK_ID
		entityStore.archetypeChunkCounts[id] = 0
		entityStore.archetypeComponentCounts[id] = sortedTypeIDs.length

		// --- Calculate and cache archetype metadata (size, component index map) ---
		const componentIndexMap = new Map()
		let totalBytes = BigUint64Array.BYTES_PER_ELEMENT // For entity ID
		for (let i = 0; i < sortedTypeIDs.length; i++) {
			const typeID = sortedTypeIDs[i]
			componentIndexMap.set(typeID, i)
			const info = Schema.componentInfo[typeID]
			if (info) totalBytes += info.byteSize
		}
		entityStore.archetypeComponentIndexMaps[id] = componentIndexMap
		entityStore.archetypeByteSizes[id] = totalBytes

		entityStore.archetypeComponentCounts[id] = sortedTypeIDs.length

		// --- Write component IDs to the packed paged buffer ---
		const requiredSpace = sortedTypeIDs.length
		let currentPage = entityStore.packedComponentIdPages[entityStore.packedComponentIdPages.length - 1]
		let spaceInPage = currentPage.length - (entityStore.nextPackedComponentIdIndex % ARCHETYPE_STORE_PAGE_SIZE_IN_U16)

		if (requiredSpace > spaceInPage) {
			// For simplicity, we don't split an archetype's list across pages.
			// If it doesn't fit, start a new page.
			const newPage = new Uint16Array(new SharedArrayBuffer(ARCHETYPE_STORE_PAGE_SIZE_IN_BYTES))
			entityStore.packedComponentIdPages.push(newPage)
			this.newlyCreatedArchetypePages.push(newPage.buffer)
			currentPage = newPage
			// Align next index to the start of the new page
			entityStore.nextPackedComponentIdIndex =
				(entityStore.packedComponentIdPages.length - 1) * ARCHETYPE_STORE_PAGE_SIZE_IN_U16
		}

		entityStore.archetypeComponentListStartIndices[id] = entityStore.nextPackedComponentIdIndex
		const pageIndex = Math.floor(entityStore.nextPackedComponentIdIndex / ARCHETYPE_STORE_PAGE_SIZE_IN_U16)
		const indexInPage = entityStore.nextPackedComponentIdIndex % ARCHETYPE_STORE_PAGE_SIZE_IN_U16
		entityStore.packedComponentIdPages[pageIndex].set(sortedTypeIDs, indexInPage)
		entityStore.nextPackedComponentIdIndex += requiredSpace

		entityStore.archetypeTransitions[id] = { add: {}, remove: {} }

		entityStore.archetypeLookup.insert(archetypeMask, id)
		this.queryManager.registerArchetype(id)
		return id
	}

	getComponentTypesFromMask(mask) {
		const types = []
		// We iterate up to the max number of components this mask can represent
		for (let i = 0; i < MAX_COMPONENTS; i++) {
			const partIndex = Math.floor(i / 64)
			const bitInPart = i % 64
			if ((mask[partIndex] & (1n << BigInt(bitInPart))) !== 0n) {
				types.push(i)
			}
		}
		return types
	}

	generateArchetypeMask(componentTypeIDs) {
		const mask = new BigUint64Array(MASK_PARTS) // Always creates a new local array
		for (const typeID of componentTypeIDs) {
			if (typeID === undefined) {
				const definedComponentNames = componentTypeIDs
					.filter(id => id !== undefined)
					.map(id => Schema.componentNames[id])
					.join(', ')
				throw new TypeError(
					`EntityManager.generateArchetypeMask: Received 'undefined' in componentTypeIDs array. ` +
						`This usually means a component name was not found or was not registered. ` +
						`Provided components: [${definedComponentNames}, undefined]`,
				)
			}
			if (typeID >= MAX_COMPONENTS) {
				throw new Error(
					`EntityManager.generateArchetypeMask: Component type ID ${typeID} exceeds the maximum of ${MAX_COMPONENTS}.`,
				)
			}
			// Instead of looking up a pre-calculated multi-part flag, we can calculate it here.
			const partIndex = Math.floor(typeID / 64)
			const bitInPart = typeID % 64
			mask[partIndex] |= 1n << BigInt(bitInPart)
		}
		return mask
	}

	hasComponentType(archetype, componentTypeID) {
		const count = entityStore.archetypeComponentCounts[archetype]
		if (count === 0) return false

		const globalStartIndex = entityStore.archetypeComponentListStartIndices[archetype]
		let low = 0
		let high = count - 1

		// Perform a binary search on the sorted array of component IDs.
		// This reads directly from the paged buffer.
		while (low <= high) {
			const mid = (low + high) >>> 1
			const globalIndex = globalStartIndex + mid
			const pageIndex = Math.floor(globalIndex / ARCHETYPE_STORE_PAGE_SIZE_IN_U16)
			const indexInPage = globalIndex % ARCHETYPE_STORE_PAGE_SIZE_IN_U16
			const midVal = entityStore.packedComponentIdPages[pageIndex][indexInPage]

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
	 * @returns {Uint16Array | undefined} A newly allocated Uint16Array containing the type IDs, or undefined if the archetype doesn't exist.
	 */
	getComponentTypeIDsForArchetype(archetypeId) {
		const count = entityStore.archetypeComponentCounts[archetypeId]
		if (count === undefined || count === 0) return new Uint16Array(0)

		const result = new Uint16Array(count)
		const globalStartIndex = entityStore.archetypeComponentListStartIndices[archetypeId]

		// This logic handles reads that span across page boundaries.
		let written = 0
		while (written < count) {
			const globalReadIndex = globalStartIndex + written
			const pageIndex = Math.floor(globalReadIndex / ARCHETYPE_STORE_PAGE_SIZE_IN_U16)
			const indexInPage = globalReadIndex % ARCHETYPE_STORE_PAGE_SIZE_IN_U16
			const page = entityStore.packedComponentIdPages[pageIndex]
			const toRead = Math.min(count - written, ARCHETYPE_STORE_PAGE_SIZE_IN_U16 - indexInPage)

			result.set(page.subarray(indexInPage, indexInPage + toRead), written)
			written += toRead
		}

		return result
	}

	getEntityLocation(entityId) {
		const index = Number(entityId & 0xffffffffn)
		const packed1 = entityStore.entityLocations[index * 2]

		// Using chunkId as the sentinel. 0 is NULL_CHUNK_ID.
		if ((packed1 & 0xffff) === 0) {
			//console.warn(`[EntityManager] getEntityLocation: No location found for entity ${entityId} (index: ${index})`)
			return undefined
		}

		return {
			archetypeId: packed1 >> 16,
			chunkId: packed1 & 0xffff,
			indexInChunk: entityStore.entityLocations[index * 2 + 1],
		}
	}

	clearAll() {
		// For a full reset, we can just re-initialize the store.
		// This is simpler than clearing each property.
		Object.assign(entityStore, {
			entityCapacity: INITIAL_ENTITY_CAPACITY,
			entityVersion: [],
			entityLocations: new Uint32Array(
				new SharedArrayBuffer(INITIAL_ENTITY_CAPACITY * 2 * Uint32Array.BYTES_PER_ELEMENT),
			),
			generations: new Array(INITIAL_ENTITY_CAPACITY).fill(0),
			freeIndices: [],
			nextEntityIndex: 1,
		})
	}

	clearAllArchetypes() {
		if (entityStore.archetypeLookup) entityStore.archetypeLookup.clear()
		Atomics.store(entityStore.nextArchetypeId, 0, 0)
		entityStore.archetypeByteSizes.fill(0)
		entityStore.archetypeComponentIndexMaps = new Array(MAX_ARCHETYPES)
		entityStore.archetypeMasks.fill(0n)
		entityStore.archetypeComponentCounts.fill(0)
		entityStore.archetypeChunkCounts.fill(0)
		entityStore.archetypeHeadChunkIds.fill(NULL_CHUNK_ID)
		entityStore.archetypeTailChunkIds.fill(NULL_CHUNK_ID)
		entityStore.archetypeLastNonFullChunkId.fill(NULL_CHUNK_ID)
		entityStore.archetypeComponentListStartIndices.fill(0)
		entityStore.archetypeTransitions = new Array(MAX_ARCHETYPES)

		// Reset the paged buffer to its initial state with one empty page.
		entityStore.packedComponentIdPages.length = 0 // Clear old pages
		const initialPage = new Uint16Array(new SharedArrayBuffer(ARCHETYPE_STORE_PAGE_SIZE_IN_BYTES))
		entityStore.packedComponentIdPages.push(initialPage)
		this.newlyCreatedArchetypePages.length = 0
		this.newlyCreatedArchetypePages.push(initialPage.buffer)

		entityStore.nextPackedComponentIdIndex = 0
		entityStore.chunkArchetypeDirtyTicks = new Array(MAX_CHUNKS)
	}

	_blitComponentDataFromBinary(
		chunkId,
		typeID,
		destIndices,
		dataOffsets,
		dataLengths,
		reader,
		currentTick,
		shouldMarkDirty,
		resolutionMap = null,
	) {

		const batchSize = destIndices.length;
		// Create a single DataView over the entire command buffer.
		const sourceView = new DataView(reader.buffer);

		for (let i = 0; i < batchSize; i++) {
			const destIndex = destIndices[i];
			const sourceOffset = dataOffsets[i]; // This is the base offset of the component data.
			// Pass the large view and the correct base offset for the component's data.
			this._writeComponentDataFromBuffer(chunkId, destIndex, typeID, sourceView, sourceOffset, resolutionMap);
		}

		if (shouldMarkDirty) {
			this._updateDirtyStateForComponent(chunkId, typeID, currentTick)
			const info = Schema.componentInfo[typeID]
			if (info.isTracked) {
				for (const destIndex of destIndices) {
					this._markNarrowPhaseDirty(chunkId, destIndex, typeID, currentTick)
				}
			}
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
			const chunkEntities = entityStore.chunkComponentData[chunkId].entities

			// --- Log Structural Change & Batch Add Entities ---
			const archetypeMask = entityStore.archetypeMasks.subarray(archetype * MASK_PARTS, (archetype + 1) * MASK_PARTS)
			const addedMask = archetypeMask
			const tickSlot = currentTick % Schema.DIRTY_HISTORY_LENGTH
			const addedMasksRing = entityStore.chunkAddedComponentMasks[chunkId]

			if (addedMasksRing) {
				for (let i = 0; i < MASK_PARTS; i++) {
					const slot = tickSlot * MASK_PARTS + i
					if (addedMask[i] > 0n) Atomics.or(addedMasksRing, slot, addedMask[i])
					if (addedMask[i] > 0n) Atomics.or(addedMasksRing, slot, addedMask[i])
				}
			}

			const entitiesSlice = entities.slice(entityCursor, entityCursor + entitiesToAddInChunk)
			entityStore.chunkComponentData[chunkId].entities.set(entitiesSlice, startIndexInChunk)

			for (let i = 0; i < entitiesToAddInChunk; i++) {
				const overallIndex = entityCursor + i
				const targetIndex = startIndexInChunk + i
				const entityId = entities[overallIndex]
				chunkEntities[targetIndex] = entityId

				const entityIndex = Number(entityId & 0xffffffffn)
				const packed = (archetype << 16) | chunkId
				entityStore.entityLocations[entityIndex * 2] = packed
				entityStore.entityLocations[entityIndex * 2 + 1] = targetIndex
			}

			const componentIdArray = this.getComponentTypeIDsForArchetype(archetype);
			const componentCount = componentIdArray.length

			// The AoS payload layout is determined by component ID order and then property declaration order.
			// We must recalculate the component offsets here to correctly read from it.
			const componentOffsets = new Map()
			let currentComponentOffset = 0
			for (const typeID of componentIdArray) {
				const info = Schema.componentInfo[typeID]
				const alignment = info.alignment
				if (alignment > 0 && currentComponentOffset % alignment !== 0) {
					currentComponentOffset += alignment - (currentComponentOffset % alignment)
				}
				componentOffsets.set(typeID, currentComponentOffset)
				currentComponentOffset += info.byteSize
			}

			const aosView = new DataView(payload)

			for (let j = 0; j < componentCount; j++) {
				const typeID = componentIdArray[j]
				const info = Schema.componentInfo[typeID]
				if (info.byteSize === 0) continue

				const destSoAArrays = entityStore.chunkComponentData[chunkId][typeID]
				const componentBaseOffset = componentOffsets.get(typeID)

				// "Interleaved Strided Copy" - Loop per-property, not per-entity.
				for (const propKey of info.propertyKeys) {
					const propInfo = info.properties[propKey]
					const destArray = destSoAArrays[propKey]

					// Read single value for this property from AoS payload once.
					const readOffset = componentBaseOffset + propInfo.offset
					const valueToBlit = aosView[propInfo.readMethod](readOffset, true)
					destArray.fill(valueToBlit, startIndexInChunk, endIndexInChunk)
				}
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

		const targetComponentIdArray = this.getComponentTypeIDsForArchetype(targetArchetypeId)
		if (!targetComponentIdArray) return plan

		for (const typeID of targetComponentIdArray) {
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
		currentTick,
		addedMask,
		removedMask,
		resolutionMap = null,
	) {
		const count = entityIds.length
		if (count === 0) return

		const copyPlan = this._getOrCreateCopyPlan(sourceArchetype, targetArchetype)
		const newLocationsMap = new Map()
		let entityCursor = 0
		const tickSlot = currentTick % Schema.DIRTY_HISTORY_LENGTH

		while (entityCursor < count) {
			const chunkId = this._findOrCreateChunkId(targetArchetype)

			const spaceInChunk = entityStore.chunkCapacities[chunkId] - entityStore.chunkSizes[chunkId]
			const entitiesToAddInChunk = Math.min(count - entityCursor, spaceInChunk)
			const startIndexInChunk = entityStore.chunkSizes[chunkId]

			// --- Log Structural Changes ---
			// Atomically update the added/removed logs for this chunk for the current tick.
			const addedMasksRing = entityStore.chunkAddedComponentMasks[chunkId]
			const removedMasksRing = entityStore.chunkRemovedComponentMasks[chunkId]

			if (addedMasksRing && removedMasksRing) {
				for (let i = 0; i < MASK_PARTS; i++) {
					const slot = tickSlot * MASK_PARTS + i
					if (addedMask[i] > 0n) Atomics.or(addedMasksRing, slot, addedMask[i])
					if (removedMask[i] > 0n) Atomics.or(removedMasksRing, slot, removedMask[i])
				}
			}

			// --- Batch Add Entities and Update Mappings ---
			for (let i = 0; i < entitiesToAddInChunk; i++) {
				const overallIndex = entityCursor + i
				const targetIndex = startIndexInChunk + i
				const entityId = entityIds[overallIndex]

				entityStore.chunkComponentData[chunkId].entities[targetIndex] = entityId
				const entityIndex = Number(entityId & 0xffffffffn)
				const packed = (targetArchetype << 16) | chunkId
				entityStore.entityLocations[entityIndex * 2] = packed
				entityStore.entityLocations[entityIndex * 2 + 1] = targetIndex
				const newLocation = { chunkId, indexInChunk: targetIndex } // Keep for local use
				newLocationsMap.set(entityId, newLocation)
			}

			// --- Batch Copy Component Data (SoA style) ---
			// loop per-property, not per-entity.
			for (const { typeID, propKey } of copyPlan.toCopy) {
				const targetArray = entityStore.chunkComponentData[chunkId][typeID][propKey]

				for (let i = 0; i < entitiesToAddInChunk; i++) {
					const overallIndex = entityCursor + i
					const targetIndex = startIndexInChunk + i
					const { chunkId: sourceChunkId, indexInChunk: sourceIndex } = sourceLocations[overallIndex]
					const sourceArray = entityStore.chunkComponentData[sourceChunkId][typeID][propKey]
					targetArray[targetIndex] = sourceArray[sourceIndex]
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
					const sourceView = new DataView(reader.buffer, sourceOffset, sourceLength);
					this._writeComponentDataFromBuffer(chunkId, destIndex, typeID, sourceView, 0, resolutionMap);
				}
			}

			// --- Batch Update High-Water Marks ---
			const targetComponentIdArray = this.getComponentTypeIDsForArchetype(targetArchetype)
			// Create a map for fast lookup of indexInArchetype
			const componentIndexMap = new Map()
			for (let i = 0; i < targetComponentIdArray.length; i++) {
				componentIndexMap.set(targetComponentIdArray[i], i)
			}

			// Only mark components that were newly initialized as dirty.
			for (const typeID of copyPlan.toInitialize) {
				const indexInArchetype = componentIndexMap.get(typeID)
				if (indexInArchetype === undefined) continue

				this._updateArchetypeDirtyTick(chunkId, indexInArchetype, currentTick)
				this._markNarrowPhaseDirtyForBatch(chunkId, startIndexInChunk, entitiesToAddInChunk, typeID, currentTick)
			}

			entityStore.chunkSizes[chunkId] += entitiesToAddInChunk
			entityCursor += entitiesToAddInChunk
		}
	}

	_removeEntitiesBatch(archetype, entitiesWithLocations) {
		const removalsByChunk = new Map()

		const componentTypeIDs = this.getComponentTypeIDsForArchetype(archetype)
		const componentCount = componentTypeIDs.length

		for (const { location } of entitiesWithLocations) {
			// Only process this removal if the entity's current
			// location actually matches the source archetype we are supposed to be
			// removing from. This prevents race conditions with deferred commands.
			if (location && location.archetypeId === archetype) {
				const { chunkId, indexInChunk } = location
				if (!removalsByChunk.has(chunkId)) {
					removalsByChunk.set(chunkId, [])
				}
				removalsByChunk.get(chunkId).push(indexInChunk)
			}
		}

		for (const [chunkId, indicesToRemove] of removalsByChunk.entries()) {
			const oldSize = entityStore.chunkSizes[chunkId]

			// Sort indices descending for safe swap-and-pop.
			indicesToRemove.sort((a, b) => b - a)
			const swappedMappings = this._removeEntitiesFromChunk(chunkId, indicesToRemove, componentTypeIDs, componentCount)

			for (const [swappedEntityId, newIndex] of swappedMappings.entries()) {
				const swappedEntityIndex = Number(swappedEntityId & 0xffffffffn)
				// Only update the indexInChunk part of the packed data.
				// This is safe because the archetype and chunkId have not changed.
				entityStore.entityLocations[swappedEntityIndex * 2 + 1] = newIndex
			}

			// Proactively update the non-full chunk pointer if this chunk just gained space.
			if (entityStore.chunkCapacities[chunkId] === oldSize && entityStore.chunkSizes[chunkId] < oldSize) {
				entityStore.archetypeLastNonFullChunkId[archetype] = chunkId
			} else if (entityStore.chunkSizes[chunkId] === 0) {
				this._destroyChunk(chunkId, archetype)
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

			if (!isLastElement) {
				const chunkEntities = entityStore.chunkComponentData[chunkId].entities
				const swappedEntityId = chunkEntities[lastIndex]
				chunkEntities.copyWithin(indexToRemove, lastIndex, lastIndex + 1)
				swappedMappings.set(swappedEntityId, indexToRemove)

				for (let i = 0; i < componentCount; i++) {
					const typeID = componentTypeIDs[i]
					const propArrays = entityStore.chunkComponentData[chunkId][typeID]
					for (const propKey in propArrays) {
						propArrays[propKey].copyWithin(indexToRemove, lastIndex, lastIndex + 1)
					}
				}
			}
			lastIndex--
		}

		entityStore.chunkSizes[chunkId] -= numToRemove
		return swappedMappings
	}

	_createEntityId() {
		const index = entityStore.freeIndices.length > 0 ? entityStore.freeIndices.pop() : entityStore.nextEntityIndex++

		if (index >= entityStore.entityCapacity) {
			const oldCapacity = entityStore.entityCapacity
			const newCapacity = oldCapacity * 2
			entityStore.entityCapacity = newCapacity

			// Resize entityLocations
			const newLocationsBuffer = new SharedArrayBuffer(newCapacity * 2 * Uint32Array.BYTES_PER_ELEMENT)
			const newLocations = new Uint32Array(newLocationsBuffer)
			newLocations.set(entityStore.entityLocations)
			entityStore.entityLocations = newLocations

			// Resize standard JS arrays
			entityStore.generations.length = newCapacity
			entityStore.generations.fill(0, oldCapacity)
			entityStore.entityVersion.length = newCapacity
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

		const oldSize = entityStore.chunkSizes[location.chunkId]
		const { chunkId, indexInChunk } = location
		const componentTypeIDs = this.getComponentTypeIDsForArchetype(archetype)
		const componentCount = componentTypeIDs.length

		const swappedMappings = this._removeEntitiesFromChunk(chunkId, [indexInChunk], componentTypeIDs, componentCount)

		for (const [swappedEntityId, newIndex] of swappedMappings.entries()) {
			const swappedEntityIndex = Number(swappedEntityId & 0xffffffffn)
			// Only update the indexInChunk part of the packed data.
			entityStore.entityLocations[swappedEntityIndex * 2 + 1] = newIndex
		}

		if (entityStore.chunkCapacities[chunkId] === oldSize && entityStore.chunkSizes[chunkId] < oldSize) {
			entityStore.archetypeLastNonFullChunkId[archetype] = chunkId
		} else if (entityStore.chunkSizes[chunkId] === 0) {
			this._destroyChunk(chunkId, archetype)
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
		// --- 1. Start search from the cached, known non-full chunk ---
		let chunkId = entityStore.archetypeLastNonFullChunkId[archetypeId]
		if (chunkId !== NULL_CHUNK_ID && entityStore.chunkSizes[chunkId] < entityStore.chunkCapacities[chunkId]) {
			return chunkId
		}

		// --- 2. If cached chunk is now full, traverse the linked list to find another ---
		// Start traversal from the head of the list.
		chunkId = entityStore.archetypeHeadChunkIds[archetypeId]
		while (chunkId !== NULL_CHUNK_ID) {
			if (entityStore.chunkSizes[chunkId] < entityStore.chunkCapacities[chunkId]) {
				entityStore.archetypeLastNonFullChunkId[archetypeId] = chunkId
				return chunkId
			}
			chunkId = entityStore.chunkNextInArchetype[chunkId]
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
		const componentIdArray = this.getComponentTypeIDsForArchetype(archetypeId)
		const componentCount = componentIdArray.length

		// Allocate the new per-component-type dirty tick buffer for this chunk.
		this._allocateChunkSharedMetadata(newChunkId, capacity, componentIdArray)

		entityStore.chunkComponentData[newChunkId] = {
			entities: new BigUint64Array(new SharedArrayBuffer(capacity * BigUint64Array.BYTES_PER_ELEMENT)),
		}

		for (const typeID of componentIdArray) {
			const info = Schema.componentInfo[typeID]
			const propArrays = {}
			for (const propKey of info.propertyKeys) {
				const constructor = info.properties[propKey].arrayConstructor
				const buffer = new SharedArrayBuffer(capacity * constructor.BYTES_PER_ELEMENT)
				propArrays[propKey] = new constructor(buffer)
			}
			entityStore.chunkComponentData[newChunkId][typeID] = propArrays
		}

		// --- Link the new chunk into the archetype's list ---
		const tailId = entityStore.archetypeTailChunkIds[archetypeId]
		if (tailId !== NULL_CHUNK_ID) {
			entityStore.chunkNextInArchetype[tailId] = newChunkId
		}
		entityStore.chunkPrevInArchetype[newChunkId] = tailId
		entityStore.chunkNextInArchetype[newChunkId] = NULL_CHUNK_ID // It's the new tail
		entityStore.archetypeTailChunkIds[archetypeId] = newChunkId
		if (entityStore.archetypeHeadChunkIds[archetypeId] === NULL_CHUNK_ID) {
			entityStore.archetypeHeadChunkIds[archetypeId] = newChunkId
		}
		entityStore.archetypeChunkCounts[archetypeId]++
		entityStore.archetypeLastNonFullChunkId[archetypeId] = newChunkId
		this.queryManager.registerChunk(archetypeId, newChunkId)

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
		const capacity = entityStore.chunkCapacities[chunkId]
		const oldArchetypeId = entityStore.chunkArchetypeIds[chunkId] // Get the archetype it USED to be.
		// A chunk on the free list has already been unlinked from its old archetype
		// and unregistered from queries by `_destroyChunk`. We do not need to do it again.
		// The `oldArchetypeId` is still valid and needed for intelligent buffer reuse.
		// Keep a reference to the old data objects before we replace them.
		const oldComponentData = entityStore.chunkComponentData[chunkId]

		// Reset the chunk's core metadata.
		entityStore.chunkArchetypeIds[chunkId] = archetypeId
		entityStore.chunkSizes[chunkId] = 0
		// Zero out stale pointers before re-linking.
		entityStore.chunkPrevInArchetype[chunkId] = NULL_CHUNK_ID
		entityStore.chunkNextInArchetype[chunkId] = NULL_CHUNK_ID

		// Create fresh containers for the new archetype's data. The entities buffer is always kept.
		const newComponentData = { entities: oldComponentData.entities }

		// Get component lists for old and new archetypes.
		const oldComponentIds = new Set(this.getComponentTypeIDsForArchetype(oldArchetypeId))
		const newComponentIds = this.getComponentTypeIDsForArchetype(archetypeId)

		// Rebuild the data structures for the new archetype.
		for (const typeID of newComponentIds) {
			if (oldComponentIds.has(typeID)) {
				// This component is shared, so we reuse its buffers.
				newComponentData[typeID] = oldComponentData[typeID]
			} else {
				// This component is new, so we must allocate new buffers for it.
				const info = Schema.componentInfo[typeID]
				const propArrays = {}
				for (const propKey of info.propertyKeys) {
					const constructor = info.properties[propKey].arrayConstructor
					const buffer = new SharedArrayBuffer(capacity * constructor.BYTES_PER_ELEMENT)
					propArrays[propKey] = new constructor(buffer)
				}
				newComponentData[typeID] = propArrays
			}
		}

		// Assign the newly constructed data objects to the chunk.
		// The old objects (oldComponentData) and any un-reused buffers
		// are now unreferenced and will be garbage collected.
		entityStore.chunkComponentData[chunkId] = newComponentData

		// The chunkArchetypeDirtyTicks buffer is size-dependent, so it must always be recreated.
		entityStore.chunkArchetypeDirtyTicks[chunkId] = undefined // De-reference old one for GC
		this._allocateChunkSharedMetadata(chunkId, capacity, newComponentIds)
		// --- Link the recycled chunk into its new archetype's list ---

		// TEMPORARY DEBUG ASSERTION: Verify metadata was correctly allocated
		const damageBufferId = this.componentManager.getTypeIDs().damageCollisionBuffer
		const physicsBufferId = this.componentManager.getTypeIDs().physicsCollisionBuffer
		const hasExpectedTrackedComponent =
			newComponentIds.includes(damageBufferId) || newComponentIds.includes(physicsBufferId)

		if (
			hasExpectedTrackedComponent &&
			(!entityStore.chunkMetadata[chunkId] ||
				(!entityStore.chunkMetadata[chunkId][damageBufferId] && !entityStore.chunkMetadata[chunkId][physicsBufferId]))
		) {
			console.error(
				`[EntityManager Debug] CRITICAL ERROR: Chunk ${chunkId} re-initialized for archetype ${archetypeId} (components: ${newComponentIds.join(',')}) but metadata for damage/physics buffer is missing!`,
			)
			// To halt execution immediately for debugging, uncomment the line below:
			// throw new Error("Chunk metadata missing expected tracked component entry after re-initialization!");
		}

		const tailId = entityStore.archetypeTailChunkIds[archetypeId]
		if (tailId !== NULL_CHUNK_ID) {
			entityStore.chunkNextInArchetype[tailId] = chunkId
		}
		entityStore.chunkPrevInArchetype[chunkId] = tailId
		entityStore.chunkNextInArchetype[chunkId] = NULL_CHUNK_ID // It's the new tail
		entityStore.archetypeTailChunkIds[archetypeId] = chunkId
		if (entityStore.archetypeHeadChunkIds[archetypeId] === NULL_CHUNK_ID) {
			entityStore.archetypeHeadChunkIds[archetypeId] = chunkId
		}
		entityStore.archetypeChunkCounts[archetypeId]++
		entityStore.archetypeLastNonFullChunkId[archetypeId] = chunkId
		this.queryManager.registerChunk(archetypeId, chunkId)

		this.newlyCreatedChunks.push(chunkId)
		return chunkId
	}
	/**
	 * Internal helper to mark a chunk as destroyed and ready for cleanup/pooling.
	 * @param {number} chunkId The ID of the chunk to destroy.
	 * @param {number} archetypeId The archetype the chunk belonged to.
	 * @private
	 */
	_destroyChunk(chunkId, archetypeId) {
		// --- Unlink the chunk from the archetype's list ---
		const prevId = entityStore.chunkPrevInArchetype[chunkId]
		const nextId = entityStore.chunkNextInArchetype[chunkId]

		if (prevId !== NULL_CHUNK_ID) entityStore.chunkNextInArchetype[prevId] = nextId
		else entityStore.archetypeHeadChunkIds[archetypeId] = nextId

		if (nextId !== NULL_CHUNK_ID) entityStore.chunkPrevInArchetype[nextId] = prevId
		else entityStore.archetypeTailChunkIds[archetypeId] = prevId

		entityStore.archetypeChunkCounts[archetypeId]--
		if (entityStore.archetypeLastNonFullChunkId[archetypeId] === chunkId) {
			entityStore.archetypeLastNonFullChunkId[archetypeId] = entityStore.archetypeHeadChunkIds[archetypeId]
		}

		this.queryManager.unregisterChunk(archetypeId, chunkId)

		// Mark the chunk as unowned and ready for recycling.
		// We DO NOT reset the archetypeId here. We need it for the intelligent
		// re-initialization logic above. It will be overwritten when reused.
		// entityStore.chunkArchetypeIds[chunkId] = 0
		entityStore.chunkSizes[chunkId] = 0 // Should already be 0, but good to be explicit.
		// We don't clear chunkComponentData here, as they will be overwritten
		// on re-initialization. However, we should clear the archetype-level ticks.
		entityStore.chunkArchetypeDirtyTicks[chunkId] = undefined
		entityStore.chunkMetadata[chunkId] = undefined
		entityStore.chunkAddedComponentMasks[chunkId] = undefined
		entityStore.chunkRemovedComponentMasks[chunkId] = undefined
		// Explicitly zero out pointers to prevent stale data traversal on bugs.
		entityStore.chunkPrevInArchetype[chunkId] = NULL_CHUNK_ID
		entityStore.chunkNextInArchetype[chunkId] = NULL_CHUNK_ID
		entityStore.freeChunkIds.push(chunkId)

		this.destroyedChunks.push(chunkId)
	}

	_writeComponentDataFromBuffer(chunkId, indexInChunk, typeID, sourceView, componentBaseOffset, resolutionMap = null) {
		const info = Schema.componentInfo[typeID];
		const destSoaArrays = entityStore.chunkComponentData[chunkId][typeID];

		// Iterate through flattened properties to write data.
		for (const propKey of info.propertyKeys) {
			const propInfo = info.properties[propKey];
			if (!propInfo) continue;

			const readOffset = componentBaseOffset + propInfo.offset;
			let value;

			// If a resolution map is provided and this property is an entity, resolve placeholders.
			if (resolutionMap && propInfo.type === 'entity') {
				const placeholderId = sourceView.getBigUint64(readOffset, true);
				if ((placeholderId >> 63n) === 1n) {
					// It's a placeholder, resolve it. Default to 0n if not found.
					value = resolutionMap.get(placeholderId) ?? 0n;
				} else {
					// It's a regular entity ID.
					value = placeholderId;
				}
			} else {
				// Standard read logic for non-entity types or when no resolution is needed.
				if (propInfo.arrayConstructor.name.startsWith('Big')) {
					value = sourceView[propInfo.readMethod](readOffset, true); // For getBigInt64/getBigUint64
				} else {
					value = sourceView[propInfo.readMethod](readOffset, true); // For getFloat32, getInt32 etc.
				}
			}

			destSoaArrays[propKey][indexInChunk] = value;
		}
	}

	/**
	 * Allocates or re-allocates the shared metadata buffers for a chunk (dirty ticks, enableable masks, etc.).
	 * @param {number} chunkId The ID of the chunk.
	 * @param {number} capacity The capacity of the chunk.
	 * @param {Uint16Array} componentIdArray The sorted array of component IDs for the chunk's archetype.
	 * @private
	 */
	_allocateChunkSharedMetadata(chunkId, capacity, componentIdArray) {
		// Allocate the per-component-type dirty tick buffer.
		const archetypeTicksBuffer = new SharedArrayBuffer(componentIdArray.length * Uint32Array.BYTES_PER_ELEMENT)
		entityStore.chunkArchetypeDirtyTicks[chunkId] = new Uint32Array(archetypeTicksBuffer)
		entityStore.chunkArchetypeDirtyTicks[chunkId].fill(0)

		// Allocate the structural change (added/removed) log buffers.
		const structuralMasksSize = MASK_PARTS * Schema.DIRTY_HISTORY_LENGTH * BigUint64Array.BYTES_PER_ELEMENT
		const addedMasksBuffer = new SharedArrayBuffer(structuralMasksSize)
		const removedMasksBuffer = new SharedArrayBuffer(structuralMasksSize)
		entityStore.chunkAddedComponentMasks[chunkId] = new BigUint64Array(addedMasksBuffer)
		entityStore.chunkRemovedComponentMasks[chunkId] = new BigUint64Array(removedMasksBuffer)

		// Allocate enableable/tracked bitmask buffers.
		const metadata = {}
		for (const typeID of componentIdArray) {
			const info = Schema.componentInfo[typeID]
			if (!info) continue

			if (info.isEnableable) {
				const words = Math.ceil(capacity / 32)
				const buffer = new SharedArrayBuffer(words * 4)
				const mask = new Uint32Array(buffer)
				mask.fill(0xffffffff) // Initialize all bits to 1 (enabled)
				if (!metadata[typeID]) metadata[typeID] = {}
				metadata[typeID].enabledMask = mask
			}

			if (info.isTracked) {
				const wordsPerFrame = Math.ceil(capacity / 32)
				const totalWords = wordsPerFrame * Schema.DIRTY_HISTORY_LENGTH
				const buffer = new SharedArrayBuffer(totalWords * 4)
				if (!metadata[typeID]) metadata[typeID] = {}
				metadata[typeID].dirtyMasks = new Uint32Array(buffer)
			}
		}
		entityStore.chunkMetadata[chunkId] = Object.keys(metadata).length > 0 ? metadata : undefined
	}

	_markNarrowPhaseDirty(chunkId, indexInChunk, typeId, tick) {
		const info = Schema.componentInfo[typeId]
		if (!info?.isTracked) return

		const componentMetadata = entityStore.chunkMetadata[chunkId]?.[typeId]
		const dirtyMasks = componentMetadata?.dirtyMasks

		if (dirtyMasks) {
			const wordsPerFrame = Math.ceil(entityStore.chunkCapacities[chunkId] / 32)
			const frameIndex = tick % Schema.DIRTY_HISTORY_LENGTH
			const wordIndexInFrame = indexInChunk >>> 5
			const bitMask = 1 << (indexInChunk & 31)
			const finalWordIndex = frameIndex * wordsPerFrame + wordIndexInFrame

			Atomics.or(dirtyMasks, finalWordIndex, bitMask)
		}
	}

	_markNarrowPhaseDirtyForBatch(chunkId, startIndex, count, typeId, tick) {
		const info = Schema.componentInfo[typeId]
		if (!info?.isTracked) return

		const componentMetadata = entityStore.chunkMetadata[chunkId]?.[typeId]
		const dirtyMasks = componentMetadata?.dirtyMasks
		if (!dirtyMasks) return

		const wordsPerFrame = Math.ceil(entityStore.chunkCapacities[chunkId] / 32)
		const frameIndex = tick % Schema.DIRTY_HISTORY_LENGTH

		for (let i = 0; i < count; i++) {
			const indexInChunk = startIndex + i
			const wordIndexInFrame = indexInChunk >>> 5
			const bitMask = 1 << (indexInChunk & 31)
			const finalWordIndex = frameIndex * wordsPerFrame + wordIndexInFrame
			Atomics.or(dirtyMasks, finalWordIndex, bitMask)
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

	_updateDirtyStateForComponent(chunkId, typeID, currentTick) {
		const archetypeId = entityStore.chunkArchetypeIds[chunkId]
		const indexInArchetype = entityStore.archetypeComponentIndexMaps[archetypeId]?.get(typeID)

		if (indexInArchetype !== undefined) {
			this._updateArchetypeDirtyTick(chunkId, indexInArchetype, currentTick)
		}
	}


	/**
	 * Calculates the total number of bytes required to store one entity in a given archetype.
	 * This is now a fast O(1) lookup from a pre-calculated cache.
	 * @param {number} archetypeId - The ID of the archetype.
	 * @returns {number} The size in bytes.
	 */
	getBytesPerEntityInArchetype(archetypeId) {
		return entityStore.archetypeByteSizes[archetypeId]
	}
}

export const entityManager = new EntityManager()
