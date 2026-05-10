import * as Schema from '../ComponentManager/ComponentSchema.js'
import { radixSort } from '../../Core/Algorithms/RadixSorter.js'
import { RawCommandBuffer } from '../SystemManager/RawCommandBuffer.js'
import { CommandBufferReader } from '../SystemManager/CommandBufferReader.js'
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

import { MAX_COMPONENTS, MASK_PARTS } from '../ComponentManager/ComponentSchema.js'
export const MAX_ARCHETYPES = 4096 // Maximum number of unique archetypes
export const MAX_CHUNKS = 65536 // Maximum number of chunks
const INITIAL_ENTITY_CAPACITY = 8192 // Initial capacity for entity-indexed arrays

const TARGET_CHUNK_SIZE_BYTES = 16384 // 16KB

// theoretical maximum number of entities a chunk can hold.
// This is derived from the target chunk size (16KB) and the smallest possible entity size
// (an entity with no components, which is just its 8-byte ID): 16384 / 8 = 2048.
export { MAX_COMPONENTS, MASK_PARTS }
export const MAX_CHUNK_CAPACITY = 2048

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
	// A packed array storing (archetypeId << 16 | chunkId) per entity. (SoA part 1)
	entityPackedLocations: new Uint32Array(
		new SharedArrayBuffer(INITIAL_ENTITY_CAPACITY * Uint32Array.BYTES_PER_ELEMENT),
	),
	// A separate array storing the indexInChunk for each entity. (SoA part 2)
	entityIndicesInChunk: new Uint32Array(new SharedArrayBuffer(INITIAL_ENTITY_CAPACITY * Uint32Array.BYTES_PER_ELEMENT)),
	// Generations are plain numbers, not bigints.
	generations: new Array(INITIAL_ENTITY_CAPACITY).fill(0),
	freeIndices: [],
	nextEntityIndex: 1,

	// --- Archetype Management (Currently Main-thread only structures) ---
	archetypeLookup: null, // Will be initialized as SharedArchetypeHashMap
	archetypeTransitions: new Array(MAX_ARCHETYPES),
	// A flat array for O(1) component index lookups within an archetype.
	// Layout: [archetypeId * MAX_COMPONENTS + componentTypeId] = indexInArchetype
	// 0xFFFF is used as a sentinel for "not present".
	archetypeComponentIndexMapData: new Uint16Array(
		new SharedArrayBuffer(MAX_ARCHETYPES * MAX_COMPONENTS * Uint16Array.BYTES_PER_ELEMENT),
	),
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
	// NEW: A cache for trackable component IDs per archetype.
	archetypeTrackableComponentIds: new Array(MAX_ARCHETYPES),

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
	async init(ecs) {
		this.queryManager = ecs.queryManager
		this.componentManager = ecs.componentManager
		this.systemManager = ecs.systemManager
		this.prefabManager = ecs.prefabManager
		this.workerManager = ecs.workerManager
		this.entityMaskManager = ecs.entityMaskManager

		// --- Reusable buffers for immediate-mode operations ---
		this.immediateBuffer = new RawCommandBuffer()
		this.immediateReader = new CommandBufferReader()

		// A reusable scratch buffer to avoid allocations in getComponentTypesFromMask
		this.componentTypesScratch = new Uint16Array(MAX_COMPONENTS)
		this.oldComponentTypesScratch = new Uint16Array(MAX_COMPONENTS)
		// A reusable scratch buffer for archetype mask operations to avoid allocations.
		this.tempArchetypeMask = new BigUint64Array(MASK_PARTS)

		// Tracks chunk IDs created within a single frame for delta-syncing to workers.
		this.newlyCreatedChunks = []
		this.destroyedChunks = []
		this.newlyCreatedArchetypePages = []

		// --- Reusable buffers for destroyEntitiesInBatch to avoid allocations ---
		this._destroyCapacity = 256
		this._destroySortKeys = new BigUint64Array(this._destroyCapacity)
		this._destroyIndicesInChunk = new Uint16Array(this._destroyCapacity)
		this._destroyEntityIds = new BigUint64Array(this._destroyCapacity)
		this._tempDestroySortKeys = new BigUint64Array(this._destroyCapacity)
		this._tempDestroyIndicesInChunk = new Uint16Array(this._destroyCapacity)
		this._tempDestroyEntityIds = new BigUint64Array(this._destroyCapacity)

		this._batchIndicesScratch = new Uint16Array(MAX_CHUNK_CAPACITY)

		this._swappedCapacity = 256
		this._swappedEntityIds = new BigUint64Array(this._swappedCapacity)
		this._swappedOldIndices = new Uint16Array(this._swappedCapacity)
		this._swappedNewIndices = new Uint16Array(this._swappedCapacity)

		// --- Reusable buffers for createEntitiesFromCommandBuffer ---
		this._varyingDescriptorsCapacity = 32
		this._varyingDescriptorsTypeId = new Uint16Array(this._varyingDescriptorsCapacity)
		this._varyingDescriptorsDataOffset = new Uint32Array(this._varyingDescriptorsCapacity)

		// --- Reusable buffers for moveEntitiesToNewArchetypeInBatch ---
		this._moveBatchCapacity = 256
		this._moveBatchSortKeys = new BigUint64Array(this._moveBatchCapacity)
		this._moveBatchEntityIds = new BigUint64Array(this._moveBatchCapacity)
		this._moveBatchOldIndices = new Uint32Array(this._moveBatchCapacity)
		this._tempMoveBatchSortKeys = new BigUint64Array(this._moveBatchCapacity)
		this._tempMoveBatchEntityIds = new BigUint64Array(this._moveBatchCapacity)
		this._tempMoveBatchOldIndices = new Uint32Array(this._moveBatchCapacity)
		this._moveBatchNewPackedLocations = new Uint32Array(this._moveBatchCapacity)
		this._moveBatchNewIndices = new Uint32Array(this._moveBatchCapacity)

		// --- Reusable buffers for batch component data copying ---
		this._copyBatchCapacity = 256
		this._copyBatchSortKeys = new BigUint64Array(this._copyBatchCapacity) // (oldChunkId << 32n) | newChunkId
		this._copyBatchOldIndices = new Uint32Array(this._copyBatchCapacity)
		this._copyBatchNewIndices = new Uint32Array(this._copyBatchCapacity)
		this._copyBatchEntityIds = new BigUint64Array(this._copyBatchCapacity)
		this._tempCopyBatchSortKeys = new BigUint64Array(this._copyBatchCapacity)
		this._tempCopyBatchOldIndices = new Uint32Array(this._copyBatchCapacity)
		this._tempCopyBatchNewIndices = new Uint32Array(this._copyBatchCapacity)
		this._tempCopyBatchEntityIds = new BigUint64Array(this._copyBatchCapacity)
		this.newlyCreatedChunks = []

		// --- Reusable buffers for _removeEntitiesFromChunk ---
		this._holeBlockCapacity = MAX_CHUNK_CAPACITY / 2 // Heuristic
		this._holeBlockStarts = new Uint16Array(this._holeBlockCapacity)
		this._holeBlockCounts = new Uint16Array(this._holeBlockCapacity)
		this._fillerBlockCapacity = MAX_CHUNK_CAPACITY / 2 // Heuristic
		this._fillerBlockStarts = new Uint16Array(this._fillerBlockCapacity)
		this._fillerBlockCounts = new Uint16Array(this._fillerBlockCapacity)

		// --- Reusable buffers for _allocateSpaceForNEntities ---
		this._allocatedBlockCapacity = 32 // Usually very few blocks are needed
		this._allocatedBlockChunkIds = new Uint16Array(this._allocatedBlockCapacity)
		this._allocatedBlockStartIndices = new Uint16Array(this._allocatedBlockCapacity)
		this._allocatedBlockCounts = new Uint16Array(this._allocatedBlockCapacity)
		this.destroyedChunks = []
		this.newlyCreatedArchetypePages = []

		// Initialize shared archetype map
		entityStore.archetypeLookup = new Map()

		// Initialize the first page for the packed component ID buffer.
		// Initialize the component index map with a sentinel value.
		entityStore.archetypeComponentIndexMapData.fill(0xffff)

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
			entityPackedLocations: entityStore.entityPackedLocations.buffer,
			entityIndicesInChunk: entityStore.entityIndicesInChunk.buffer,
			nextArchetypeId: entityStore.nextArchetypeId.buffer,
			archetypeMasks: entityStore.archetypeMasks.buffer,
			archetypeComponentCounts: entityStore.archetypeComponentCounts.buffer,
			archetypeChunkCounts: entityStore.archetypeChunkCounts.buffer,
			archetypeHeadChunkIds: entityStore.archetypeHeadChunkIds.buffer,
			archetypeTailChunkIds: entityStore.archetypeTailChunkIds.buffer,
			archetypeLastNonFullChunkId: entityStore.archetypeLastNonFullChunkId.buffer,
			archetypeComponentListStartIndices: entityStore.archetypeComponentListStartIndices.buffer,
			archetypeByteSizes: entityStore.archetypeByteSizes.buffer,
			archetypeComponentIndexMapData: entityStore.archetypeComponentIndexMapData.buffer,

			// --- Chunk Metadata ---
			chunkArchetypeIds: entityStore.chunkArchetypeIds.buffer,
			chunkSizes: entityStore.chunkSizes.buffer,
			chunkCapacities: entityStore.chunkCapacities.buffer,
			chunkPrevInArchetype: entityStore.chunkPrevInArchetype.buffer,
			chunkNextInArchetype: entityStore.chunkNextInArchetype.buffer,

			// --- Shared Data Structures ---
			chunkArchetypeDirtyTicks: entityStore.chunkArchetypeDirtyTicks,
			chunkMetadata: entityStore.chunkMetadata,

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
	 * Creates a single entity from a pre-compiled "live" SoA payload.
	 * This is the internal "fast path" for immediate-mode single entity creation.
	 * @param {object} payload - The compiled payload object from `PayloadCompiler`.
	 * @param {number} currentTick current game tick.
	 */
	createEntityFromSoaPayload(payload, currentTick) {
		const { archetypeId, buffers } = payload

		const entityId = this._createEntityId()
		const chunkId = this._findOrCreateChunkId(archetypeId)
		const indexInChunk = this._addEntityToChunk(chunkId, entityId)

		const entityIndex = Number(entityId & 0xffffffffn)
		entityStore.entityPackedLocations[entityIndex] = (archetypeId << 16) | chunkId
		entityStore.entityIndicesInChunk[entityIndex] = indexInChunk

		// --- Log structural change for `added:` queries ---
		const archetypeMaskOffset = archetypeId * MASK_PARTS
		const addedMask = entityStore.archetypeMasks.subarray(archetypeMaskOffset, archetypeMaskOffset + MASK_PARTS)
		this._logStructuralChange(chunkId, addedMask, null, currentTick)

		// --- Write component data from the live payload's buffers ---
		const componentCount = this.getComponentTypeIDsForArchetype(archetypeId, this.componentTypesScratch)
		for (let i = 0; i < componentCount; i++) {
			const typeId = this.componentTypesScratch[i]
			const componentName = Schema.componentNames[typeId]
			const sourceBuffers = buffers[componentName]
			const destArrays = entityStore.chunkComponentData[chunkId][typeId]
			const info = Schema.componentInfo[typeId]

			for (const propKey of info.propertyKeys) {
				const value = sourceBuffers[propKey][0]
				destArrays[propKey][indexInChunk] = value

				// Set the initial state mask if this property value corresponds to one.
				const propMap = this.entityMaskManager.initialStateMap.get(typeId)
				if (propMap) {
					const valueMap = propMap.get(propKey)
					if (valueMap) {
						const maskId = valueMap.get(value)
						if (maskId !== undefined) {
							this.entityMaskManager.setBit(maskId, chunkId, indexInChunk)
						}
					}
				}
			}
			this.markComponentDirty(chunkId, typeId, currentTick)
		}

		// Use the archetype's pre-cached list of trackable components to fire "modified" events.
		const trackableIds = entityStore.archetypeTrackableComponentIds[archetypeId]

		for (const typeId of trackableIds) {
			const modifiedMaskId = this.entityMaskManager.componentToModifiedMaskId.get(typeId)
			this.entityMaskManager.fireEventById(modifiedMaskId, entityId, currentTick)
		}
		return entityId
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
	addComponent(entityId, payload, currentTick) {
		if (!this.isEntityActive(entityId)) return false
		
		const entityIndex = Number(entityId & 0xffffffffn)
		const oldPackedLocation = entityStore.entityPackedLocations[entityIndex]
		if (oldPackedLocation === 0) return false
		const sourceArchetypeId = oldPackedLocation >> 16
		const oldChunkId = oldPackedLocation & 0xffff
		const oldIndexInChunk = entityStore.entityIndicesInChunk[entityIndex]

		// The payload for `addComponent` must be for a single component. The compiler
		// attaches the componentTypeId directly to the payload.
		const componentTypeId = payload.componentTypeId
		if (componentTypeId === undefined) {
			throw new Error('EntityManager.addComponent: Payload is missing componentTypeId. This method only accepts single-component payloads.')
		}
		if (this.archetypeHasComponent(sourceArchetypeId, componentTypeId)) {
			console.warn(
				`EntityManager.addComponent: Entity ${entityId} already has component ${this.componentManager.getComponentNameByTypeID(componentTypeId)}.`,
			)
			return false
		}

		// Use the pre-allocated temporary mask to avoid allocations.
		const sourceMaskOffset = sourceArchetypeId * MASK_PARTS
		for (let i = 0; i < MASK_PARTS; i++) {
			this.tempArchetypeMask[i] = entityStore.archetypeMasks[sourceMaskOffset + i]
		}
		const targetArchetypeMask = this.tempArchetypeMask

		if (componentTypeId >= MAX_COMPONENTS) {
			throw new Error(`Component type ID ${componentTypeId} exceeds MAX_COMPONENTS (${MAX_COMPONENTS}).`)
		}
		const partIndex = Math.floor(componentTypeId / 64)
		const bitInPart = componentTypeId % 64
		targetArchetypeMask[partIndex] |= 1n << BigInt(bitInPart)
		const targetArchetypeId = this.getArchetypeByMask(targetArchetypeMask)

		// The move operation itself no longer handles data assignment.
		const newLocationData = this._moveEntityToNewArchetype(
			entityId,
			sourceArchetypeId,
			oldChunkId,
			oldIndexInChunk,
			targetArchetypeId,
			currentTick,
		)

		if (newLocationData) {
			const [newChunkId, newIndexInChunk] = newLocationData
			// After the move, write the data for the new component at the new location.
			const { buffers } = payload
			const componentName = Schema.componentNames[componentTypeId]
			const sourceBuffers = buffers[componentName]
			const destArrays = entityStore.chunkComponentData[newChunkId][componentTypeId]
			const info = Schema.componentInfo[componentTypeId]
			const propMap = this.entityMaskManager.initialStateMap.get(componentTypeId)

			for (const propKey of info.propertyKeys) {
				const value = sourceBuffers[propKey][0]
				destArrays[propKey][newIndexInChunk] = value

				// Set the initial state mask for the newly added component.
				// Since this is an 'add' operation, we only need to set the new bit.
				if (propMap) {
					const valueMap = propMap.get(propKey)
					if (valueMap) {
						const maskId = valueMap.get(value)
						if (maskId !== undefined) {
							this.entityMaskManager.setBit(maskId, newChunkId, newIndexInChunk)
						}
					}
				}
			}

			// Mark the newly added component as dirty for broad-phase `modified:` queries.
			this.markComponentDirty(newChunkId, componentTypeId, currentTick)

			// Fire the "modified" event for the newly added component if it's trackable.
			const modifiedMaskId = this.entityMaskManager.componentToModifiedMaskId.get(componentTypeId)
			if (modifiedMaskId !== undefined) {
				this.entityMaskManager.fireEventById(modifiedMaskId, entityId, currentTick)
			}
			return true
		}
		return false
	}

	/**
	 * Removes a component from an entity immediately.
	 * @param {bigint} entityId The entity to modify.
	 * @param {number} componentTypeId The type ID of the component to remove.
	 * @param {number} currentTick The current game tick.
	 * @returns {boolean} True on success.
	 */
	removeComponent(entityId, componentTypeId, currentTick) {
		if (!this.isEntityActive(entityId)) return false
		const entityIndex = Number(entityId & 0xffffffffn)
		const oldPackedLocation = entityStore.entityPackedLocations[entityIndex]
		if (oldPackedLocation === 0) return false
		const sourceArchetypeId = oldPackedLocation >> 16
		const oldChunkId = oldPackedLocation & 0xffff
		const oldIndexInChunk = entityStore.entityIndicesInChunk[entityIndex]
		if (!this.archetypeHasComponent(sourceArchetypeId, componentTypeId)) return false

		// Use the pre-allocated temporary mask to avoid allocations.
		const sourceMaskOffset = sourceArchetypeId * MASK_PARTS
		for (let i = 0; i < MASK_PARTS; i++) {
			this.tempArchetypeMask[i] = entityStore.archetypeMasks[sourceMaskOffset + i]
		}
		const targetArchetypeMask = this.tempArchetypeMask

		if (componentTypeId >= MAX_COMPONENTS) {
			// This case is handled by hasComponentType, but good to be safe.
			return false
		}
		const partIndex = Math.floor(componentTypeId / 64)
		const bitInPart = componentTypeId % 64
		targetArchetypeMask[partIndex] &= ~(1n << BigInt(bitInPart))
		const targetArchetypeId = this.getArchetypeByMask(targetArchetypeMask)

		// The move method now returns the new location object or null.
		// We can convert this to a boolean for the public API.
		return !!this._moveEntityToNewArchetype(entityId, sourceArchetypeId, oldChunkId, oldIndexInChunk, targetArchetypeId, currentTick)
	}

	/**
	 * Destroys a single entity, recycling its ID.
	 * @param {bigint} entityID - entity to destroy.
	 * @returns {boolean} True if entity was active and destroyed.
	 */
	destroyEntity(entityID) {
		if (!this.isEntityActive(entityID)) return false

		const entityIndex = Number(entityID & 0xffffffffn)
		const archetypeId = this.getArchetypeForEntity(entityID)

		// Only try to get location and remove from chunk if the entity has an archetype.
		if (archetypeId !== undefined) {
			const packedLocation = entityStore.entityPackedLocations[entityIndex]
			if (packedLocation > 0) {
				const chunkId = packedLocation & 0xffff
				const indexInChunk = entityStore.entityIndicesInChunk[entityIndex]
				this._removeEntity(archetypeId, entityID, chunkId, indexInChunk)
			}
		}
		entityStore.entityVersion[entityIndex] = undefined
		// Clear the location data in the new SoA arrays
		entityStore.entityPackedLocations[entityIndex] = 0
		entityStore.entityIndicesInChunk[entityIndex] = 0
		entityStore.generations[entityIndex]++ // Increment generation on destruction
		entityStore.freeIndices.push(entityIndex)

		return true
	}

	/**
	 * Destroys all entities within a specific chunk. This is a highly efficient
	 * bulk operation used by the command buffer.
	 * @param {number} chunkId The ID of the chunk to clear.
	 */
	destroyEntitiesInChunk(chunkId) {
		const archetypeId = entityStore.chunkArchetypeIds[chunkId]
		// `0` is a valid archetype ID
		// after a world reset. A chunk is only invalid for destruction if it's already
		// empty. A non-empty chunk is guaranteed to have a valid archetypeId.
		if (entityStore.chunkSizes[chunkId] === 0) {
			return // Chunk is already empty or invalid.
		}

		const entities = entityStore.chunkComponentData[chunkId].entities
		const size = entityStore.chunkSizes[chunkId]

		// Invalidate all entities in the chunk.
		for (let i = 0; i < size; i++) {
			const entityId = entities[i]
			const index = Number(entityId & 0xffffffffn)
			entityStore.entityVersion[index] = undefined
			entityStore.entityPackedLocations[index] = 0
			entityStore.entityIndicesInChunk[index] = 0
			entityStore.generations[index]++
			entityStore.freeIndices.push(index)
		}

		// Destroy the chunk itself, which unlinks it and adds it to the free pool.
		this._destroyChunk(chunkId, archetypeId)
	}

	/**
	 * Destroys all entities matching a given query.
	 * @param {number} queryId The ID of the query.
	 */
	destroyByQuery(queryId) {
		const query = this.queryManager.getQueryById(queryId)
		if (!query) {
			console.warn(`[EntityManager] destroyByQuery: Query with ID ${queryId} not found.`)
			return
		}

		// This is a simple but effective implementation. It iterates over all matching chunks
		// and destroys them. This is very fast for queries that don't share chunks with other entities.
		const chunkIds = query.getAllChunks() // Use getAllChunks to ensure we get all of them.
		for (const chunkId of chunkIds) {
			this.destroyEntitiesInChunk(chunkId)
		}
	}

	/**
	 * Destroys a batch of entities efficiently.
	 * @param {bigint[]} entityIds The array of entity IDs to destroy.
	 */
	destroyEntitiesInBatch(entityIds, entityCount) {
		// 1. Populate sortable scratch arrays from the input entityIds
		let count = 0
		const limit = entityCount ?? entityIds.length
		for (let i = 0; i < limit; i++) {
			const entityId = entityIds[i]
			if (!this.isEntityActive(entityId)) continue

			const entityIndex = Number(entityId & 0xffffffffn)
			const packedLocation = entityStore.entityPackedLocations[entityIndex]
			const chunkId = packedLocation & 0xffff
			if (chunkId === 0) continue

			if (count >= this._destroyCapacity) this._resizeDestroyBatchArrays()

			const archetypeId = packedLocation >> 16
			// The sort key groups by chunk, then by archetype.
			this._destroySortKeys[count] = (BigInt(chunkId) << 32n) | BigInt(archetypeId)
			this._destroyIndicesInChunk[count] = entityStore.entityIndicesInChunk[entityIndex]
			this._destroyEntityIds[count] = entityId
			count++
		}

		if (count === 0) return

		// 2. Radix sort all scratch arrays based on the composite sort key.
		radixSort(
			this._destroySortKeys.subarray(0, count),
			this._destroyIndicesInChunk.subarray(0, count),
			this._destroyEntityIds.subarray(0, count),
			null,
			null,
			this._tempDestroySortKeys.subarray(0, count),
			this._tempDestroyIndicesInChunk.subarray(0, count),
			this._tempDestroyEntityIds.subarray(0, count),
			null,
			null,
		)

		// 3. Iterate through the sorted arrays and process one chunk-batch at a time.
		let i = 0
		while (i < count) {
			const sortKey = this._destroySortKeys[i]
			const chunkId = Number(sortKey >> 32n)
			const archetypeId = Number(sortKey & 0xffffffffn)

			// Find the end of the current chunk's batch.
			let batchEnd = i + 1
			while (batchEnd < count && this._destroySortKeys[batchEnd] === sortKey) {
				batchEnd++
			}
			const batchSize = batchEnd - i

			// Get component types for the archetype into the scratch buffer.
			const componentCount = this.getComponentTypeIDsForArchetype(archetypeId, this.componentTypesScratch)
			const componentTypeIDs = this.componentTypesScratch.subarray(0, componentCount)

			// Copy indices for this batch to a temporary, sortable array.
			for (let k = 0; k < batchSize; k++) {
				this._batchIndicesScratch[k] = this._destroyIndicesInChunk[i + k]
			}
			const indicesToRemove = this._batchIndicesScratch.subarray(0, batchSize)
			indicesToRemove.sort((a, b) => b - a) // Sort descending for swap-and-pop.

			const oldSize = entityStore.chunkSizes[chunkId]
			const swapCount = this._removeEntitiesFromChunk(chunkId, indicesToRemove, componentTypeIDs, componentCount)

			// Update locations for any entities that were swapped.
			for (let j = 0; j < swapCount; j++) {
				const swappedEntityId = this._swappedEntityIds[j]
				const newIndex = this._swappedNewIndices[j]
				const swappedEntityIndex = Number(swappedEntityId & 0xffffffffn)
				entityStore.entityIndicesInChunk[swappedEntityIndex] = newIndex
			}

			// Notify mask manager of the swaps.
			if (swapCount > 0) {
				this.entityMaskManager.handleEntitiesSwapped(
					chunkId,
					swapCount,
					this._swappedOldIndices,
					this._swappedNewIndices,
				)
			}

			// Invalidate the destroyed entities for this batch.
			for (let j = 0; j < batchSize; j++) {
				const entityId = this._destroyEntityIds[i + j]
				const index = Number(entityId & 0xffffffffn)
				entityStore.entityVersion[index] = undefined
				entityStore.entityPackedLocations[index] = 0
				entityStore.entityIndicesInChunk[index] = 0
				entityStore.generations[index]++
				entityStore.freeIndices.push(index)
			}

			// Check if chunk became non-full or empty
			if (entityStore.chunkCapacities[chunkId] === oldSize && entityStore.chunkSizes[chunkId] < oldSize) {
				entityStore.archetypeLastNonFullChunkId[archetypeId] = chunkId
			} else if (entityStore.chunkSizes[chunkId] === 0) {
				this._destroyChunk(chunkId, archetypeId)
			}

			// Move to the next batch.
			i = batchEnd
		}
	}

	destroyAll() {
		// This is a full reset. 
		this.clearAllArchetypes() // Removes all chunks
		this.clearAll() // Resets all entity-related arrays and counters

		// Also reset chunk state for true test isolation. This prevents chunks freed
		// in one test from being recycled in another, which could cause capacity mismatches.
		entityStore.nextChunkId = 1
		entityStore.freeChunkIds.length = 0
		// Notify the query manager that all archetypes are gone so it can clear its matching chunks/archetypes,
		// but without destroying the query objects themselves.
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
		const packed = entityStore.entityPackedLocations[index]
		return packed > 0 ? packed >> 16 : undefined
	}

	getArchetype(componentTypeIDs) {
		// Use scratch buffer to avoid allocations. This loop handles any iterable.
		let i = 0
		for (const typeId of componentTypeIDs) {
			this.componentTypesScratch[i++] = typeId
		}
		const sortedTypeIDs = this.componentTypesScratch.subarray(0, i)
		// The subarray is a view, so sorting it sorts the underlying scratch buffer.
		sortedTypeIDs.sort((a, b) => a - b)

		// Use the pre-allocated temporary mask to avoid allocation in generateArchetypeMask.
		this.generateArchetypeMask(sortedTypeIDs, this.tempArchetypeMask)

		return this.getArchetypeByMask(this.tempArchetypeMask, sortedTypeIDs)
	}

	getArchetypeByMask(archetypeMask, sortedTypeIDs) {
		// Generate a string key from the BigUint64Array mask for use in the Map.
		// This is faster than JSON.stringify and guaranteed to be unique.
		const key = `${archetypeMask[0]}-${archetypeMask[1]}-${archetypeMask[2]}-${archetypeMask[3]}`

		// 1. Look up the mask in the shared hash map.
		const existingId = entityStore.archetypeLookup.get(key)

		// 2. If an ID is found, verify it's not a hash collision.
		if (existingId !== undefined) {
			// With a string key from the full mask, collisions are impossible.
			// We can directly return the ID.
			return existingId
		}

		// 4. If we're here, it's a cache miss or a collision. Create a new archetype.
		return this._createArchetype(key, archetypeMask, sortedTypeIDs)
	}

	_createArchetype(key, archetypeMask, sortedTypeIDs) {
		const id = Atomics.add(entityStore.nextArchetypeId, 0, 1)
		if (id >= MAX_ARCHETYPES) {
			throw new Error(`EntityManager: Maximum number of archetypes (${MAX_ARCHETYPES}) reached.`)
		}

		let componentCount
		if (!sortedTypeIDs) {
			componentCount = this.getComponentTypesFromMask(archetypeMask, this.componentTypesScratch)
			sortedTypeIDs = this.componentTypesScratch // Use the scratch buffer directly
		} else {
			componentCount = sortedTypeIDs.length
		}

		// --- Write to Shared Archetype Store ---
		entityStore.archetypeMasks.set(archetypeMask, id * MASK_PARTS)
		entityStore.archetypeHeadChunkIds[id] = NULL_CHUNK_ID
		entityStore.archetypeTailChunkIds[id] = NULL_CHUNK_ID
		entityStore.archetypeLastNonFullChunkId[id] = NULL_CHUNK_ID
		entityStore.archetypeChunkCounts[id] = 0
		entityStore.archetypeComponentCounts[id] = componentCount

		// --- Calculate and cache archetype metadata (size, component index map) ---
		const componentIndexMapOffset = id * MAX_COMPONENTS
		// This is not on a hot path, so a fill is acceptable for safety.
		entityStore.archetypeComponentIndexMapData.fill(
			0xffff,
			componentIndexMapOffset,
			componentIndexMapOffset + MAX_COMPONENTS,
		)

		let totalBytes = BigUint64Array.BYTES_PER_ELEMENT // For entity ID
		for (let i = 0; i < componentCount; i++) {
			const typeID = sortedTypeIDs[i]
			entityStore.archetypeComponentIndexMapData[componentIndexMapOffset + typeID] = i
			const info = Schema.componentInfo[typeID]
			if (info) totalBytes += info.byteSize
		}
		entityStore.archetypeByteSizes[id] = totalBytes

		// --- Write component IDs to the packed paged buffer ---
		const requiredSpace = componentCount
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

		// Manual copy to avoid subarray allocation
		const page = entityStore.packedComponentIdPages[pageIndex]
		for (let i = 0; i < componentCount; i++) {
			page[indexInPage + i] = sortedTypeIDs[i]
		}
		entityStore.nextPackedComponentIdIndex += requiredSpace

		// This is just a placeholder for a future caching mechanism. No allocation needed.
		entityStore.archetypeTransitions[id] = null

		// Only insert into the hash map if it was a true "miss". On collision, we don't
		// insert, making the new archetype uncached (slower to find, but correct).
		entityStore.archetypeLookup.set(key, id)

		// --- NEW: Pre-cache trackable component IDs for this archetype ---
		const trackableIds = []
		for (let i = 0; i < componentCount; i++) {
			const typeId = sortedTypeIDs[i]
			if (this.entityMaskManager.componentToModifiedMaskId.has(typeId)) {
				trackableIds.push(typeId)
			}
		}
		entityStore.archetypeTrackableComponentIds[id] = new Uint16Array(trackableIds)

		this.queryManager.registerArchetype(id)
		return id
	}

	getComponentTypesFromMask(mask, outArray) {
		let count = 0
		// We iterate up to the max number of components this mask can represent
		for (let i = 0; i < MAX_COMPONENTS; i++) {
			const partIndex = Math.floor(i / 64)
			const bitInPart = i % 64
			if ((mask[partIndex] & (1n << BigInt(bitInPart))) !== 0n) {
				if (outArray) {
					outArray[count++] = i
				}
			}
		}
		return count
	}

	generateArchetypeMask(componentTypeIDs, outMask) {
		outMask.fill(0n)
		for (const typeID of componentTypeIDs) {
			if (typeID === undefined) {
				// This error message is intentionally simple to avoid allocations from string building.
				throw new TypeError(
					`EntityManager.generateArchetypeMask: Received 'undefined' in componentTypeIDs array. ` +
						`This usually means a component name was not found or was not registered.`,
				)
			}
			if (typeID >= MAX_COMPONENTS) {
				throw new Error(
					`EntityManager.generateArchetypeMask: Component type ID ${typeID} exceeds the maximum of ${MAX_COMPONENTS}.`,
				)
			}

			const partIndex = Math.floor(typeID / 64)
			const bitInPart = typeID % 64
			outMask[partIndex] |= 1n << BigInt(bitInPart)
		}
	}

	archetypeHasComponent(archetype, componentTypeID) {
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
	 * This version writes into a pre-allocated `outArray` for performance.
	 * @param {number} archetypeId The ID of the archetype.
	 * @param {Uint16Array} outArray The array to write the type IDs into.
	 * @returns {number} The number of component type IDs written to the array.
	 */
	getComponentTypeIDsForArchetype(archetypeId, outArray) {
		const count = entityStore.archetypeComponentCounts[archetypeId]
		if (count === undefined || count === 0) return 0

		if (outArray.length < count) {
			throw new Error(
				`[EntityManager] Output array for getComponentTypeIDsForArchetype is too small. Required: ${count}, Provided: ${outArray.length}`,
			)
		}

		const globalStartIndex = entityStore.archetypeComponentListStartIndices[archetypeId]

		// This logic handles reads that span across page boundaries.
		let written = 0
		while (written < count) {
			const globalReadIndex = globalStartIndex + written
			const pageIndex = Math.floor(globalReadIndex / ARCHETYPE_STORE_PAGE_SIZE_IN_U16)
			const indexInPage = globalReadIndex % ARCHETYPE_STORE_PAGE_SIZE_IN_U16
			const page = entityStore.packedComponentIdPages[pageIndex]
			const toRead = Math.min(count - written, ARCHETYPE_STORE_PAGE_SIZE_IN_U16 - indexInPage)

			// Manual copy to avoid subarray allocation.
			for (let i = 0; i < toRead; i++) {
				outArray[written + i] = page[indexInPage + i]
			}
			written += toRead
		}

		return count
	}

	/**
	 * Gets the sorted array of component type IDs for a given archetype.
	 * This is a convenience method that allocates a new array. For performance-critical
	 * code, use the version that accepts an `outArray`.
	 * @param {number} archetypeId The ID of the archetype.
	 * @returns {Uint16Array} A newly allocated Uint16Array containing the type IDs.
	 */
	getComponentTypeIDsForArchetypeAlloc(archetypeId) {
		const count = entityStore.archetypeComponentCounts[archetypeId]
		if (count === undefined || count === 0) {
			return new Uint16Array(0)
		}
		const outArray = new Uint16Array(count)
		this.getComponentTypeIDsForArchetype(archetypeId, outArray)
		return outArray
	}

	getEntityLocation(entityId) {
		const index = Number(entityId & 0xffffffffn)
		const packed1 = entityStore.entityPackedLocations[index]

		// Using chunkId as the sentinel. 0 is NULL_CHUNK_ID.
		if ((packed1 & 0xffff) === 0) {
			//console.warn(`[EntityManager] getEntityLocation: No location found for entity ${entityId} (index: ${index})`)
			return undefined
		}

		//! alloc object, method should not be used for systems or entity command buffer
		return {
			archetypeId: packed1 >> 16,
			chunkId: packed1 & 0xffff,
			indexInChunk: entityStore.entityIndicesInChunk[index],
		}
	}

	clearAll() {
		// For a full reset, we can just re-initialize the store.
		// This is simpler than clearing each property.
		Object.assign(entityStore, {
			entityCapacity: INITIAL_ENTITY_CAPACITY,
			entityVersion: [],
			entityPackedLocations: new Uint32Array(
				new SharedArrayBuffer(INITIAL_ENTITY_CAPACITY * Uint32Array.BYTES_PER_ELEMENT),
			),
			entityIndicesInChunk: new Uint32Array(
				new SharedArrayBuffer(INITIAL_ENTITY_CAPACITY * Uint32Array.BYTES_PER_ELEMENT),
			),
			generations: new Array(INITIAL_ENTITY_CAPACITY).fill(0),
			freeIndices: [],
			nextEntityIndex: 1,
		})
	}

	clearAllArchetypes() {
		// --- HMR/Reset---
		// Before wiping the archetype data, we must notify any listeners that all
		// existing chunks are about to be destroyed. This allows managers like
		// EntityMaskManager to clean up their own state and avoid stale references.
		for (let i = 1; i < entityStore.nextChunkId; i++) {
			if (entityStore.chunkArchetypeIds[i] !== 0 && !entityStore.freeChunkIds.includes(i)) {
				this.entityMaskManager.handleChunkDestroyed(i)
			}
		}

		if (entityStore.archetypeLookup) entityStore.archetypeLookup.clear()
		// Do NOT reset the archetype ID counter. Resetting it invalidates pre-compiled
		// payloads that hold archetype IDs, which is a common pattern in tests and can
		// lead to hard-to-debug data corruption issues. Archetype IDs should be stable
		// for the lifetime of the application.
		// Atomics.store(entityStore.nextArchetypeId, 0, 0)
		entityStore.archetypeByteSizes.fill(0)
		entityStore.archetypeComponentIndexMapData.fill(0xffff)
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

	_createEntityId() {
		const index = entityStore.freeIndices.length > 0 ? entityStore.freeIndices.pop() : entityStore.nextEntityIndex++

		if (index >= entityStore.entityCapacity) {
			const oldCapacity = entityStore.entityCapacity
			const newCapacity = oldCapacity * 2
			entityStore.entityCapacity = newCapacity

			// Resize entityLocations
			const newPackedLocationsBuffer = new SharedArrayBuffer(newCapacity * Uint32Array.BYTES_PER_ELEMENT)
			const newPackedLocations = new Uint32Array(newPackedLocationsBuffer)
			newPackedLocations.set(entityStore.entityPackedLocations)
			entityStore.entityPackedLocations = newPackedLocations

			const newIndicesInChunkBuffer = new SharedArrayBuffer(newCapacity * Uint32Array.BYTES_PER_ELEMENT)
			const newIndicesInChunk = new Uint32Array(newIndicesInChunkBuffer)
			newIndicesInChunk.set(entityStore.entityIndicesInChunk)
			entityStore.entityIndicesInChunk = newIndicesInChunk
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

	_removeEntity(archetype, entityId, chunkId, indexInChunk) {
		const oldSize = entityStore.chunkSizes[chunkId]
		
		// Use scratch buffer for component types
		const componentCount = this.getComponentTypeIDsForArchetype(archetype, this.componentTypesScratch)
		const componentTypeIDs = this.componentTypesScratch.subarray(0, componentCount)

		// Use scratch buffer for indices to remove
		this._batchIndicesScratch[0] = indexInChunk
		const indicesToRemove = this._batchIndicesScratch.subarray(0, 1)

		const swapCount = this._removeEntitiesFromChunk(chunkId, indicesToRemove, componentTypeIDs, componentCount)

		for (let i = 0; i < swapCount; i++) {
			const swappedEntityId = this._swappedEntityIds[i]
			const newIndex = this._swappedNewIndices[i]
			const swappedEntityIndex = Number(swappedEntityId & 0xffffffffn)
			entityStore.entityIndicesInChunk[swappedEntityIndex] = newIndex
		}

		if (swapCount > 0) {
			this.entityMaskManager.handleEntitiesSwapped(
				chunkId,
				swapCount,
				this._swappedOldIndices.subarray(0, swapCount),
				this._swappedNewIndices.subarray(0, swapCount),
			)
		}
		if (entityStore.chunkCapacities[chunkId] === oldSize && entityStore.chunkSizes[chunkId] < oldSize) {
			entityStore.archetypeLastNonFullChunkId[archetype] = chunkId
		} else if (entityStore.chunkSizes[chunkId] === 0) {
			this._destroyChunk(chunkId, archetype)
		}
	}

	/**
	 * The internal workhorse for removing one or more entities from a chunk using
	 * the efficient swap-and-pop algorithm.
	 * @param {number} chunkId The chunk to modify.
	 * @param {number[]} indicesToRemove An array of indices within the chunk to remove.
	 * @param {Uint16Array} componentTypeIDs The component IDs of the chunk's archetype.
	 * @param {number} componentCount The number of components in the archetype.
	 * @returns {number} The number of entities that were swapped to fill gaps.
	 * @private
	 */
	_removeEntitiesFromChunk(chunkId, indicesToRemove, componentTypeIDs, componentCount) {
		const removeCount = indicesToRemove.length
		if (removeCount === 0) return 0

		const chunkData = entityStore.chunkComponentData[chunkId]
		const oldSize = entityStore.chunkSizes[chunkId]
		const newSize = oldSize - removeCount
		let swapCount = 0

		// temporary `isRemoved` buffer enable bulk memory copies
		const isRemoved = new Uint8Array(oldSize)

		for (const index of indicesToRemove) {
			if (index < oldSize) {
				isRemoved[index] = 1
			}
		}

		let holeBlockCount = 0
		let i = 0
		while (i < newSize) {
			if (isRemoved[i]) {
				const start = i
				while (i < newSize && isRemoved[i]) {
					i++
				}
				if (holeBlockCount >= this._holeBlockCapacity) this._resizeHoleFillerArrays()
				this._holeBlockStarts[holeBlockCount] = start
				this._holeBlockCounts[holeBlockCount] = i - start
				holeBlockCount++
			} else {
				i++
			}
		}

		let fillerBlockCount = 0
		i = newSize
		while (i < oldSize) {
			if (!isRemoved[i]) {
				const start = i
				while (i < oldSize && !isRemoved[i]) {
					i++
				}
				if (fillerBlockCount >= this._fillerBlockCapacity) this._resizeHoleFillerArrays()
				this._fillerBlockStarts[fillerBlockCount] = start
				this._fillerBlockCounts[fillerBlockCount] = i - start
				fillerBlockCount++
			} else {
				i++
			}
		}

		// --- Perform bulk copies by matching holes with fillers ---
		let holeIdx = 0
		let holeOffset = 0
		let fillerIdx = fillerBlockCount - 1
		let fillerOffset = 0

		while (holeIdx < holeBlockCount && fillerIdx >= 0) {
			const holeCount = this._holeBlockCounts[holeIdx]
			const fillerCount = this._fillerBlockCounts[fillerIdx]
			const numToCopy = Math.min(holeCount - holeOffset, fillerCount - fillerOffset)
			if (numToCopy <= 0) break // Safeguard

			const destIndex = this._holeBlockStarts[holeIdx] + holeOffset
			const sourceIndex = this._fillerBlockStarts[fillerIdx] + (fillerCount - fillerOffset) - numToCopy

			// --- Bulk copy entities and all their component data ---
			const entitiesToSwap = chunkData.entities.subarray(sourceIndex, sourceIndex + numToCopy)
			chunkData.entities.set(entitiesToSwap, destIndex)

			for (let k = 0; k < componentCount; k++) {
				const typeID = componentTypeIDs[k]
				this._copyComponentDataBlock(chunkId, typeID, sourceIndex, chunkId, destIndex, numToCopy)
			}

			// --- Record the swaps for location updates ---
			for (let j = 0; j < numToCopy; j++) {
				if (swapCount >= this._swappedCapacity) this._resizeSwappedArrays()
				this._swappedEntityIds[swapCount] = chunkData.entities[destIndex + j]
				this._swappedOldIndices[swapCount] = sourceIndex + j
				this._swappedNewIndices[swapCount] = destIndex + j
				swapCount++
			}

			holeOffset += numToCopy
			if (holeOffset >= holeCount) {
				holeIdx++
				holeOffset = 0
			}

			fillerOffset += numToCopy
			if (fillerOffset >= fillerCount) {
				fillerIdx--
				fillerOffset = 0
			}
		}

		entityStore.chunkSizes[chunkId] = newSize
		return swapCount
	}

	_resizeMoveBatchArrays(requiredCapacity) {
		const oldCapacity = this._moveBatchCapacity
		const newCapacity = Math.max(oldCapacity * 2, requiredCapacity)
		console.warn(`[EntityManager] Resizing move batch arrays from ${oldCapacity} to ${newCapacity}.`)
		this._moveBatchCapacity = newCapacity

		this._moveBatchSortKeys = new BigUint64Array(newCapacity)
		this._moveBatchEntityIds = new BigUint64Array(newCapacity)
		this._moveBatchOldIndices = new Uint32Array(newCapacity)
		this._tempMoveBatchSortKeys = new BigUint64Array(newCapacity)
		this._tempMoveBatchEntityIds = new BigUint64Array(newCapacity)
		this._tempMoveBatchOldIndices = new Uint32Array(newCapacity)
		this._moveBatchNewPackedLocations = new Uint32Array(newCapacity)
		this._moveBatchNewIndices = new Uint32Array(newCapacity)

		// Re-initialize by copying old data
		this._moveBatchSortKeys.set(this._moveBatchSortKeys.subarray(0, oldCapacity))
		this._moveBatchEntityIds.set(this._moveBatchEntityIds.subarray(0, oldCapacity))
		this._moveBatchOldIndices.set(this._moveBatchOldIndices.subarray(0, oldCapacity))
		this._moveBatchNewPackedLocations.set(this._moveBatchNewPackedLocations.subarray(0, oldCapacity))
		this._moveBatchNewIndices.set(this._moveBatchNewIndices.subarray(0, oldCapacity))
	}

	_resizeCopyBatchArrays(requiredCapacity) {
		const oldCapacity = this._copyBatchCapacity
		const newCapacity = Math.max(oldCapacity * 2, requiredCapacity)
		console.warn(`[EntityManager] Resizing copy batch arrays from ${oldCapacity} to ${newCapacity}.`)
		this._copyBatchCapacity = newCapacity

		this._copyBatchSortKeys = new BigUint64Array(newCapacity)
		this._copyBatchOldIndices = new Uint32Array(newCapacity)
		this._copyBatchNewIndices = new Uint32Array(newCapacity)
		this._copyBatchEntityIds = new BigUint64Array(newCapacity)

		this._tempCopyBatchSortKeys = new BigUint64Array(newCapacity)
		this._tempCopyBatchOldIndices = new Uint32Array(newCapacity)
		this._tempCopyBatchNewIndices = new Uint32Array(newCapacity)
		this._tempCopyBatchEntityIds = new BigUint64Array(newCapacity)

		// No need to copy old data, these are populated per batch.
	}

	_resizeVaryingDescriptors(requiredCapacity) {
		const oldCapacity = this._varyingDescriptorsCapacity
		const newCapacity = Math.max(oldCapacity * 2, requiredCapacity)
		console.warn(`[EntityManager] Resizing varying descriptors buffer from ${oldCapacity} to ${newCapacity}.`)
		this._varyingDescriptorsCapacity = newCapacity

		const newTypeIds = new Uint16Array(newCapacity)
		newTypeIds.set(this._varyingDescriptorsTypeId)
		this._varyingDescriptorsTypeId = newTypeIds

		const newDataOffsets = new Uint32Array(newCapacity)
		newDataOffsets.set(this._varyingDescriptorsDataOffset)
		this._varyingDescriptorsDataOffset = newDataOffsets
	}

	_resizeDestroyBatchArrays() {
		const oldCapacity = this._destroyCapacity
		const newCapacity = oldCapacity * 2
		console.warn(`[EntityManager] Resizing destroy batch arrays from ${oldCapacity} to ${newCapacity}.`)
		this._destroyCapacity = newCapacity

		const newSortKeys = new BigUint64Array(newCapacity)
		newSortKeys.set(this._destroySortKeys)
		this._destroySortKeys = newSortKeys

		const newIndicesInChunk = new Uint16Array(newCapacity)
		newIndicesInChunk.set(this._destroyIndicesInChunk)
		this._destroyIndicesInChunk = newIndicesInChunk

		const newEntityIds = new BigUint64Array(newCapacity)
		newEntityIds.set(this._destroyEntityIds)
		this._destroyEntityIds = newEntityIds

		const newTempSortKeys = new BigUint64Array(newCapacity)
		this._tempDestroySortKeys = newTempSortKeys

		const newTempIndices = new Uint16Array(newCapacity)
		this._tempDestroyIndicesInChunk = newTempIndices

		const newTempEntityIds = new BigUint64Array(newCapacity)
		this._tempDestroyEntityIds = newTempEntityIds
	}

	_resizeSwappedArrays() {
		const oldCapacity = this._swappedCapacity
		const newCapacity = oldCapacity * 2
		console.warn(`[EntityManager] Resizing swapped entity arrays from ${oldCapacity} to ${newCapacity}.`)
		this._swappedCapacity = newCapacity

		const newEntityIds = new BigUint64Array(newCapacity)
		newEntityIds.set(this._swappedEntityIds)
		this._swappedEntityIds = newEntityIds

		const newOldIndices = new Uint16Array(newCapacity)
		newOldIndices.set(this._swappedOldIndices)
		this._swappedOldIndices = newOldIndices

		const newNewIndices = new Uint16Array(newCapacity)
		newNewIndices.set(this._swappedNewIndices)
		this._swappedNewIndices = newNewIndices
	}

	_resizeHoleFillerArrays() {
		const oldHoleCapacity = this._holeBlockCapacity
		const newHoleCapacity = oldHoleCapacity * 2
		console.warn(`[EntityManager] Resizing hole block arrays from ${oldHoleCapacity} to ${newHoleCapacity}.`)
		this._holeBlockCapacity = newHoleCapacity
		const newHoleStarts = new Uint16Array(newHoleCapacity)
		newHoleStarts.set(this._holeBlockStarts)
		this._holeBlockStarts = newHoleStarts
		const newHoleCounts = new Uint16Array(newHoleCapacity)
		newHoleCounts.set(this._holeBlockCounts)
		this._holeBlockCounts = newHoleCounts

		// Assuming filler capacity grows at the same rate
		this._fillerBlockCapacity = newHoleCapacity
		this._fillerBlockStarts = new Uint16Array(newHoleCapacity)
		this._fillerBlockCounts = new Uint16Array(newHoleCapacity)
	}

	_copyComponentData(fromChunkId, typeId, fromIndex, toChunkId, toIndex) {
		const info = Schema.componentInfo[typeId]
		const fromArrays = entityStore.chunkComponentData[fromChunkId][typeId]
		const toArrays = entityStore.chunkComponentData[toChunkId][typeId]

		// It's possible for one of the arrays to not exist if the component is being added/removed.
		if (!fromArrays || !toArrays) return

		for (const propKey of info.propertyKeys) {
			// Check if property exists on both to be safe, though they should be consistent.
			if (toArrays[propKey] && fromArrays[propKey]) {
				toArrays[propKey][toIndex] = fromArrays[propKey][fromIndex]
			}
		}
	}

	_copyComponentDataBlock(fromChunkId, typeId, fromIndex, toChunkId, toIndex, count) {
		const info = Schema.componentInfo[typeId]
		const fromSoA = entityStore.chunkComponentData[fromChunkId][typeId]
		const toSoA = entityStore.chunkComponentData[toChunkId][typeId]

		for (const propKey of info.propertyKeys) {
			this._copyTypedArrayBlock(toSoA[propKey], toIndex, fromSoA[propKey], fromIndex, count)
		}
	}

	_logStructuralChange(chunkId, addedMask, removedMask, tick) {
		if (addedMask) {
			const ring = entityStore.chunkAddedComponentMasks[chunkId]
			if (ring) {
				const tickSlot = tick % Schema.DIRTY_HISTORY_LENGTH
				const maskOffset = tickSlot * MASK_PARTS
				for (let i = 0; i < MASK_PARTS; i++) {
					Atomics.or(ring, maskOffset + i, addedMask[i])
				}
			}
		}
		if (removedMask) {
			const ring = entityStore.chunkRemovedComponentMasks[chunkId]
			if (ring) {
				const tickSlot = tick % Schema.DIRTY_HISTORY_LENGTH
				const maskOffset = tickSlot * MASK_PARTS
				for (let i = 0; i < MASK_PARTS; i++) {
					Atomics.or(ring, maskOffset + i, removedMask[i])
				}
			}
		}
	}

	/**
	 * The internal workhorse for moving an entity to a new archetype. This is a slow,
	 * immediate-mode operation that involves several allocations. The performant,
	 * allocation-free path for structural changes is handled by the CommandBufferExecutor's
	 * modification pass.
	 * @param {bigint} entityId The entity to move.
	 * @param {number} sourceArchetypeId The entity's current archetype ID.
	 * @param {number} oldChunkId The entity's current chunk ID.
	 * @param {number} oldIndexInChunk The entity's current index in its chunk.
	 * @param {number} targetArchetypeId The entity's destination archetype ID.
	 * @param {number} currentTick The current game tick.
	 * @returns {[number, number] | null} A tuple of `[newChunkId, newIndexInChunk]`, or null on failure.
	 * @private
	 */
	_moveEntityToNewArchetype(entityId, sourceArchetypeId, oldChunkId, oldIndexInChunk, targetArchetypeId, currentTick) {
		// 1. Find/create a spot in the new archetype
		const newChunkId = this._findOrCreateChunkId(targetArchetypeId)
		const newIndexInChunk = this._addEntityToChunk(newChunkId, entityId)

		// 2. Copy common component data using masks
		const sourceMaskOffset = sourceArchetypeId * MASK_PARTS
		const targetMaskOffset = targetArchetypeId * MASK_PARTS

		for (let i = 0; i < MASK_PARTS; i++) {
			const commonMaskPart =
				entityStore.archetypeMasks[sourceMaskOffset + i] & entityStore.archetypeMasks[targetMaskOffset + i]
			if (commonMaskPart === 0n) continue

			for (let j = 0; j < 64; j++) {
				if ((commonMaskPart & (1n << BigInt(j))) !== 0n) {
					const typeId = i * 64 + j
					this._copyComponentData(oldChunkId, typeId, oldIndexInChunk, newChunkId, newIndexInChunk)
				}
			}
		}

		// 4. Notify EntityMaskManager of the move. This must happen BEFORE removing the entity
		// from the old chunk, otherwise the old chunk's mask data might be destroyed before we can read it.
		this.entityMaskManager.handleEntityMoved(
			{ chunkId: oldChunkId, indexInChunk: oldIndexInChunk },
			{ chunkId: newChunkId, indexInChunk: newIndexInChunk },
		)

		// 5. Remove entity from old chunk
		this._removeEntity(sourceArchetypeId, entityId, oldChunkId, oldIndexInChunk)

		// 6. Update entity's global location
		const entityIndex = Number(entityId & 0xffffffffn)
		entityStore.entityPackedLocations[entityIndex] = (targetArchetypeId << 16) | newChunkId
		entityStore.entityIndicesInChunk[entityIndex] = newIndexInChunk

		// 7. Mark structural changes for reactive queries (broad-phase)
		// Use scratch buffers to avoid allocating new masks.
		const addedMask = this.tempArchetypeMask
		const removedMask = this._destroySortKeys // Re-using a large-enough scratch buffer
		addedMask.fill(0n)
		removedMask.fill(0n)

		for (let i = 0; i < MASK_PARTS; i++) {
			const sourcePart = entityStore.archetypeMasks[sourceMaskOffset + i]
			const targetPart = entityStore.archetypeMasks[targetMaskOffset + i]
			addedMask[i] = targetPart & ~sourcePart
			removedMask[i] = sourcePart & ~targetPart
		}

		// Log both added and removed component masks on the NEW chunk.
		// A reactive query that matches the entity's new state needs to find
		// the structural change event at the entity's new location.
		this._logStructuralChange(newChunkId, addedMask, removedMask, currentTick)

		return [newChunkId, newIndexInChunk]
	}

	/**
	 * The internal workhorse for copying a block of data from one TypedArray to another.
	 * @param {TypedArray} dest The destination array.
	 * @param {number} destOffset The offset in the destination array to start writing.
	 * @param {TypedArray} source The source array.
	 * @param {number} sourceOffset The offset in the source array to start reading.
	 * @param {number} count The number of elements to copy.
	 * @private
	 */
	_copyTypedArrayBlock(dest, destOffset, source, sourceOffset, count) {
		// manually allocating approximately same performance and same GC, noise level difference.
		// both approaches allocating, there is no way around it in js, unless wasm used (yet to be measured)
		dest.set(source.subarray(sourceOffset, sourceOffset + count), destOffset)
	}

	/**
	 * Moves a batch of entities from a source archetype to a target archetype.
	 * This is a highly optimized method for the command buffer executor.
	 * @param {number} sourceArchetypeId The source archetype.
	 * @param {number} targetArchetypeId The target archetype.
	 * @param {BigUint64Array} entityIds The entity IDs to move.
	 * @param {Uint32Array} oldPackedLocations The packed old locations of the entities.
	 * @param {Uint32Array} oldIndicesInChunk The old indices in chunk for the entities.
	 * @param {number} count The number of entities in the batch.
	 * @param {number} currentTick The current game tick for logging structural changes.
	 * @private
	 */
	moveEntitiesToNewArchetypeInBatch(
		sourceArchetypeId,
		targetArchetypeId,
		entityIds,
		oldPackedLocations,
		oldIndicesInChunk,
		count,
		currentTick,
	) {
		if (count === 0) return
		if (count > this._moveBatchCapacity) this._resizeMoveBatchArrays(count)

		// Ensure copy batch arrays are large enough.
		if (count > this._copyBatchCapacity) this._resizeCopyBatchArrays(count)


		// --- 1. PREPARATION ---
		const sourceMaskOffset = sourceArchetypeId * MASK_PARTS
		const targetMaskOffset = targetArchetypeId * MASK_PARTS
		const commonMask = this.tempArchetypeMask
		const addedMask = this._destroySortKeys // Reuse a large enough scratch buffer
		const removedMask = this._tempDestroySortKeys // Reuse another

		for (let i = 0; i < MASK_PARTS; i++) {
			const sourcePart = entityStore.archetypeMasks[sourceMaskOffset + i]
			const targetPart = entityStore.archetypeMasks[targetMaskOffset + i]
			commonMask[i] = sourcePart & targetPart
			addedMask[i] = targetPart & ~sourcePart
			removedMask[i] = sourcePart & ~targetPart
		}

		// --- 2. BULK ALLOCATION & LOCATION UPDATE ---
		const blockCount = this._allocateSpaceForNEntities(targetArchetypeId, count)

		let entityBatchIndex = 0
		for (let i = 0; i < blockCount; i++) {
			const chunkId = this._allocatedBlockChunkIds[i]
			const startIndex = this._allocatedBlockStartIndices[i]
			const numInBlock = this._allocatedBlockCounts[i]

			const newPackedLocation = (targetArchetypeId << 16) | chunkId

			for (let j = 0; j < numInBlock; j++) {
				const currentIndexInBatch = entityBatchIndex + j
				const entityId = entityIds[currentIndexInBatch]
				const entityIndex = Number(entityId & 0xffffffffn)
				const newIndexInChunk = startIndex + j

				entityStore.chunkComponentData[chunkId].entities[newIndexInChunk] = entityId

				this._moveBatchNewPackedLocations[currentIndexInBatch] = newPackedLocation
				this._moveBatchNewIndices[currentIndexInBatch] = newIndexInChunk
				entityStore.entityPackedLocations[entityIndex] = newPackedLocation
				entityStore.entityIndicesInChunk[entityIndex] = newIndexInChunk

				const oldPackedLocation = oldPackedLocations[currentIndexInBatch]
				const oldChunkId = oldPackedLocation & 0xffff
				const oldIndex = oldIndicesInChunk[currentIndexInBatch]
				this._copyBatchSortKeys[currentIndexInBatch] = (BigInt(chunkId) << 32n) | BigInt(oldChunkId)
				this._copyBatchOldIndices[currentIndexInBatch] = oldIndex
				this._copyBatchNewIndices[currentIndexInBatch] = newIndexInChunk
				this._copyBatchEntityIds[currentIndexInBatch] = entityId
			}
			this._logStructuralChange(chunkId, addedMask, removedMask, currentTick)
			entityBatchIndex += numInBlock
		}

		// --- 3. BULK COPY COMMON COMPONENTS ---
		// Sort the copy requests to group by (oldChunkId, newChunkId) and then by oldIndex.
		radixSort(
			this._copyBatchSortKeys.subarray(0, count),
			this._copyBatchOldIndices.subarray(0, count),
			this._copyBatchNewIndices.subarray(0, count),
			this._copyBatchEntityIds.subarray(0, count),
			null,
			this._tempCopyBatchSortKeys.subarray(0, count),
			this._tempCopyBatchOldIndices.subarray(0, count),
			this._tempCopyBatchNewIndices.subarray(0, count),
			this._tempCopyBatchEntityIds.subarray(0, count),
			null,
		)

		let copyIdx = 0
		while (copyIdx < count) {
			const sortKey = this._copyBatchSortKeys[copyIdx]
			// The sort key is (newChunkId << 32) | oldChunkId.
			// This sorts by oldChunkId first, then newChunkId.
			const newChunkId = Number(sortKey >> 32n)
			const oldChunkId = Number(sortKey & 0xffffffffn)

			let copyBatchEnd = copyIdx + 1
			while (copyBatchEnd < count && this._copyBatchSortKeys[copyBatchEnd] === sortKey) {
				copyBatchEnd++
			}
			const copyBatchSize = copyBatchEnd - copyIdx

			// Now, within this (oldChunkId, newChunkId) group, identify contiguous blocks of indices.
			let blockStart = copyIdx
			while (blockStart < copyBatchEnd) {
				const currentOldIndex = this._copyBatchOldIndices[blockStart]
				const currentNewIndex = this._copyBatchNewIndices[blockStart]
				let blockSize = 1
				while (
					blockStart + blockSize < copyBatchEnd &&
					this._copyBatchOldIndices[blockStart + blockSize] === currentOldIndex + blockSize &&
					this._copyBatchNewIndices[blockStart + blockSize] === currentNewIndex + blockSize
				) {
					blockSize++
				}

				for (let part = 0; part < MASK_PARTS; part++) {
					let maskPart = commonMask[part]
					if (maskPart === 0n) continue
					for (let bit = 0; bit < 64; bit++) {
						if ((maskPart & (1n << BigInt(bit))) !== 0n) {
							const typeId = part * 64 + bit
							this._copyComponentDataBlock(oldChunkId, typeId, currentOldIndex, newChunkId, currentNewIndex, blockSize)
						}
					}
				}
				blockStart += blockSize
			}
			copyIdx = copyBatchEnd
		}


		// --- 4. MASK MANAGER UPDATE ---
		// This MUST happen BEFORE the removal pass. The removal pass performs swap-and-pop,
		// which overwrites the data at the old entity slot. We need to copy the mask data
		// from the old slot before it gets overwritten. The handleEntitiesMovedInBatch
		// method is responsible for clearing the bit at the old location after copying,
		// so we don't leave stale data behind.
		this.entityMaskManager.handleEntitiesMovedInBatch(
			oldPackedLocations,
			oldIndicesInChunk,
			this._moveBatchNewPackedLocations,
			this._moveBatchNewIndices,
			count,
		)

		// --- 5. REMOVAL PASS (Batched by source chunk) ---
		// The copy batch arrays are now sorted by oldChunkId, so we can iterate
		// through them to create removal batches without another sort.
		let removalIdx = 0
		while (removalIdx < count) {
			const sortKey = this._copyBatchSortKeys[removalIdx]
			const sourceChunkId = Number(sortKey & 0xffffffffn) // Unpack oldChunkId

			// Find the end of the current batch for this source chunk.
			let batchEnd = removalIdx + 1
			while (batchEnd < count && Number(this._copyBatchSortKeys[batchEnd] & 0xffffffffn) === sourceChunkId) {
				batchEnd++
			}
			const batchSize = batchEnd - removalIdx

			const componentCount = this.getComponentTypeIDsForArchetype(sourceArchetypeId, this.componentTypesScratch)
			const componentTypeIDs = this.componentTypesScratch.subarray(0, componentCount)

			// Gather the indices to remove for this chunk.
			for (let k = 0; k < batchSize; k++) {
				this._batchIndicesScratch[k] = this._copyBatchOldIndices[removalIdx + k]
			}
			const indicesToRemove = this._batchIndicesScratch.subarray(0, batchSize)
			indicesToRemove.sort((a, b) => b - a) // Sort descending for swap-and-pop.

			const oldSize = entityStore.chunkSizes[sourceChunkId]
			const swapCount = this._removeEntitiesFromChunk(sourceChunkId, indicesToRemove, componentTypeIDs, componentCount)

			// Update locations for any entities that were swapped.
			for (let j = 0; j < swapCount; j++) {
				const swappedEntityId = this._swappedEntityIds[j]
				const newIndex = this._swappedNewIndices[j]
				const swappedEntityIndex = Number(swappedEntityId & 0xffffffffn)
				entityStore.entityIndicesInChunk[swappedEntityIndex] = newIndex
			}

			// Notify mask manager of the swaps.
			if (swapCount > 0) {
				this.entityMaskManager.handleEntitiesSwapped(
					sourceChunkId,
					swapCount,
					this._swappedOldIndices,
					this._swappedNewIndices,
				)
			}

			// Check if chunk became non-full or empty
			if (entityStore.chunkCapacities[sourceChunkId] === oldSize && entityStore.chunkSizes[sourceChunkId] < oldSize) {
				entityStore.archetypeLastNonFullChunkId[sourceArchetypeId] = sourceChunkId
			} else if (entityStore.chunkSizes[sourceChunkId] === 0) {
				this._destroyChunk(sourceChunkId, sourceArchetypeId)
			}

			// Move to the next batch.
			removalIdx = batchEnd
		}
	}

	_addEntityToChunk(chunkId, entityId) {
		const index = entityStore.chunkSizes[chunkId]
		entityStore.chunkComponentData[chunkId].entities[index] = entityId
		entityStore.chunkSizes[chunkId]++
		return index
	}

	/**
	 * Internal helper to create a new, unlinked chunk for a given archetype.
	 * This contains the core allocation logic without the "find" part.
	 * @param {number} archetypeId The archetype for the new chunk.
	 * @returns {number} The ID of the newly created chunk.
	 * @private
	 */
	_getNewChunk(archetypeId) {
		// --- Chunk Pooling Logic ---
		if (entityStore.freeChunkIds.length > 0) {
			const recycledChunkId = entityStore.freeChunkIds.pop()
			return this._reinitializeChunk(recycledChunkId, archetypeId)
		}

		const newChunkId = entityStore.nextChunkId++
		if (newChunkId >= MAX_CHUNKS) {
			throw new Error(`EntityManager: Maximum number of chunks (${MAX_CHUNKS}) reached.`)
		}

		// --- Dynamic Chunk Capacity Calculation ---
		const bytesPerEntity = this.getBytesPerEntityInArchetype(archetypeId)
		const calculatedCapacity =
			bytesPerEntity > 0 ? Math.floor(TARGET_CHUNK_SIZE_BYTES / bytesPerEntity) : MIN_CHUNK_CAPACITY
		const capacity = Math.max(MIN_CHUNK_CAPACITY, calculatedCapacity)

		entityStore.chunkArchetypeIds[newChunkId] = archetypeId
		entityStore.chunkSizes[newChunkId] = 0
		entityStore.chunkCapacities[newChunkId] = capacity

		const componentCount = this.getComponentTypeIDsForArchetype(archetypeId, this.componentTypesScratch)
		this._allocateChunkSharedMetadata(newChunkId, capacity, this.componentTypesScratch, componentCount)

		entityStore.chunkComponentData[newChunkId] = {
			entities: new BigUint64Array(new SharedArrayBuffer(capacity * BigUint64Array.BYTES_PER_ELEMENT)),
		}

		for (let i = 0; i < componentCount; i++) {
			const typeID = this.componentTypesScratch[i]
			const info = Schema.componentInfo[typeID]
			const propArrays = {}
			for (const propKey of info.propertyKeys) {
				const constructor = info.properties[propKey].arrayConstructor
				const buffer = new SharedArrayBuffer(capacity * constructor.BYTES_PER_ELEMENT)
				propArrays[propKey] = new constructor(buffer)
			}
			entityStore.chunkComponentData[newChunkId][typeID] = propArrays
		}

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

		this.queryManager.registerChunk(archetypeId, newChunkId)
		this.entityMaskManager.handleChunkCreated(newChunkId, archetypeId)
		this.newlyCreatedChunks.push(newChunkId)

		return newChunkId
	}

	/**
	 * Allocates space for N entities in a given archetype, returning a list of
	 * locations. It will fill existing chunks before creating new ones.
	 * @param {number} archetypeId The archetype to allocate in.
	 * @param {number} numToAllocate The number of entities to allocate space for.
	 * @returns {number} The number of blocks allocated. The block data is in the pre-allocated SoA buffers.
	 * @private
	 */
	_allocateSpaceForNEntities(archetypeId, numToAllocate) {
		let blockCount = 0
		let remaining = numToAllocate

		// 1. Try to fill the cached non-full chunk.
		let chunkId = entityStore.archetypeLastNonFullChunkId[archetypeId]
		if (chunkId !== NULL_CHUNK_ID) {
			const space = entityStore.chunkCapacities[chunkId] - entityStore.chunkSizes[chunkId]
			if (space > 0) {
				const allocatedInBlock = Math.min(remaining, space)
				if (blockCount >= this._allocatedBlockCapacity) this._resizeAllocatedBlockArrays()
				this._allocatedBlockChunkIds[blockCount] = chunkId
				this._allocatedBlockStartIndices[blockCount] = entityStore.chunkSizes[chunkId]
				this._allocatedBlockCounts[blockCount] = allocatedInBlock
				blockCount++

				entityStore.chunkSizes[chunkId] += allocatedInBlock
				remaining -= allocatedInBlock
			}
		}

		// 2. Create new chunks for any remaining entities.
		while (remaining > 0) {
			const newChunkId = this._getNewChunk(archetypeId)
			const allocatedInBlock = Math.min(remaining, entityStore.chunkCapacities[newChunkId])

			if (blockCount >= this._allocatedBlockCapacity) this._resizeAllocatedBlockArrays()
			this._allocatedBlockChunkIds[blockCount] = newChunkId
			this._allocatedBlockStartIndices[blockCount] = 0
			this._allocatedBlockCounts[blockCount] = allocatedInBlock
			blockCount++

			entityStore.chunkSizes[newChunkId] = allocatedInBlock
			remaining -= allocatedInBlock

			if (allocatedInBlock < entityStore.chunkCapacities[newChunkId]) {
				entityStore.archetypeLastNonFullChunkId[archetypeId] = newChunkId
			} else {
				entityStore.archetypeLastNonFullChunkId[archetypeId] = NULL_CHUNK_ID
			}
		}
		return blockCount
	}

	_resizeAllocatedBlockArrays() {
		const oldCapacity = this._allocatedBlockCapacity
		const newCapacity = oldCapacity * 2
		console.warn(`[EntityManager] Resizing allocated block arrays from ${oldCapacity} to ${newCapacity}.`)
		this._allocatedBlockCapacity = newCapacity
		const newChunkIds = new Uint16Array(newCapacity)
		newChunkIds.set(this._allocatedBlockChunkIds)
		this._allocatedBlockChunkIds = newChunkIds
		const newStartIndices = new Uint16Array(newCapacity)
		newStartIndices.set(this._allocatedBlockStartIndices)
		this._allocatedBlockStartIndices = newStartIndices
		const newCounts = new Uint16Array(newCapacity)
		newCounts.set(this._allocatedBlockCounts)
		this._allocatedBlockCounts = newCounts
	}

	/**
	 * Finds a chunk within an archetype that has free space, or creates a new one if necessary.
	 * This is a critical path for entity creation. See `EntityManager.md` for scalability notes.
	 * @param {number} archetypeId The ID of the archetype to find a chunk in.
	 * @returns {number | null} The ID of a chunk with space, or null if the archetype is invalid.
	 * @private
	 */
	_findOrCreateChunkId(archetypeId) {
		// --- 1. Fast Path: Check the cached, known non-full chunk ---
		let chunkId = entityStore.archetypeLastNonFullChunkId[archetypeId]
		if (chunkId !== NULL_CHUNK_ID && entityStore.chunkSizes[chunkId] < entityStore.chunkCapacities[chunkId]) {
			return chunkId
		}

		// --- 2. Slow Path: Traverse the linked list to find any non-full chunk ---
		chunkId = entityStore.archetypeHeadChunkIds[archetypeId]
		while (chunkId !== NULL_CHUNK_ID) {
			if (entityStore.chunkSizes[chunkId] < entityStore.chunkCapacities[chunkId]) {
				entityStore.archetypeLastNonFullChunkId[archetypeId] = chunkId // Update cache
				return chunkId
			}
			chunkId = entityStore.chunkNextInArchetype[chunkId]
		}

		// --- 3. If no non-full chunk is found, create a new one. ---
		const newChunkId = this._getNewChunk(archetypeId)
		entityStore.archetypeLastNonFullChunkId[archetypeId] = newChunkId
		return newChunkId
	}

	/**
	 * Internal helper to mark a chunk as destroyed and ready for cleanup/pooling.
	 * @param {number} chunkId The ID of the chunk to destroy.
	 * @param {number} archetypeId The archetype the chunk belonged to.
	 * @private
	 */
	_destroyChunk(chunkId, archetypeId) {
		// Notify the mask manager BEFORE unlinking and adding to free pool.
		this.queryManager.unregisterChunk(archetypeId, chunkId)
		this.entityMaskManager.handleChunkDestroyed(chunkId)

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

		// Mark the chunk as unowned and ready for recycling.
		// We keep the old archetypeId here so that the intelligent recycling logic in
		// `_reinitializeChunk` can compare the old and new archetypes to reuse buffers.
		// The chunk is unlinked and has size 0, so it's safe from normal iteration.
		entityStore.chunkSizes[chunkId] = 0
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
		const info = Schema.componentInfo[typeID]
		const chunkData = entityStore.chunkComponentData[chunkId]
		const destSoaArrays = chunkData[typeID]

		// Iterate through flattened properties to write data.
		for (const propKey of info.propertyKeys) {
			const propInfo = info.properties[propKey]

			const readOffset = componentBaseOffset + propInfo.offset
			let value

			// If a resolution map is provided and this property is an entity, resolve placeholders.
			if (resolutionMap && propInfo.type === 'entity') {

				const placeholderId = sourceView.getBigUint64(readOffset, true)
				if (placeholderId >> 63n === 1n) {
					const placeholderIndex = Number(placeholderId & 0xffffffffn)
					const resolvedId = resolutionMap.get(placeholderIndex)
					// Check for the "doomed" bit (bit 62).
					if ((resolvedId & (1n << 62n)) !== 0n) {
						// The placeholder was destroyed in the same frame. Resolve to null.
						value = 0n
					} else {
						value = resolvedId ?? 0n // If not doomed, use the ID (or 0n if not found).
					}
				} else {
					// It's a regular entity ID.
					value = placeholderId
				}
			} else {
				// Standard read logic for non-entity types or when no resolution is needed.
				if (propInfo.arrayConstructor.name.startsWith('Big')) {
					//! probably figure out some enum types for data, idk
					value = sourceView[propInfo.readMethod](readOffset, true) // For getBigInt64/getBigUint64
				} else {
					value = sourceView[propInfo.readMethod](readOffset, true) // For getFloat32, getInt32 etc.
				}
			}

			destSoaArrays[propKey][indexInChunk] = value
		}
	}

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

		// The entities buffer is always kept.
		const newComponentData = { entities: oldComponentData.entities }

		// --- Intelligent Recycling Logic ---
		// 1. Get component lists for both archetypes.
		const newComponentCount = this.getComponentTypeIDsForArchetype(archetypeId, this.componentTypesScratch)
		const oldComponentCount = this.getComponentTypeIDsForArchetype(oldArchetypeId, this.oldComponentTypesScratch)

		// 2. Create a set of old component IDs for efficient lookup.
		// This is a temporary allocation, but it's acceptable as it enables huge savings.
		const oldComponentIdSet = new Set(this.oldComponentTypesScratch.subarray(0, oldComponentCount))

		// 3. Iterate over NEW components and decide whether to reuse or allocate.
		for (let i = 0; i < newComponentCount; i++) {
			const typeId = this.componentTypesScratch[i]
			const info = Schema.componentInfo[typeId]

			if (oldComponentIdSet.has(typeId)) {
				// --- REUSE PATH ---
				const propArrays = oldComponentData[typeId]

				// Zero-out the reused buffers for safety.
				for (const propKey of info.propertyKeys) {
					const buffer = propArrays[propKey]
					if (buffer instanceof BigInt64Array || buffer instanceof BigUint64Array) {
						buffer.fill(0n)
					} else {
						buffer.fill(0)
					}
				}
				newComponentData[typeId] = propArrays
			} else {
				// --- ALLOCATE PATH (Component is new to this chunk) ---
				const propArrays = {}
				for (const propKey of info.propertyKeys) {
					const constructor = info.properties[propKey].arrayConstructor
					const buffer = new SharedArrayBuffer(capacity * constructor.BYTES_PER_ELEMENT)
					propArrays[propKey] = new constructor(buffer)
				}
				newComponentData[typeId] = propArrays
			}
		}

		// Assign the newly constructed data objects to the chunk.
		// The old objects (oldComponentData) and any un-reused buffers
		// are now unreferenced and will be garbage collected.
		entityStore.chunkComponentData[chunkId] = newComponentData

		// The chunkArchetypeDirtyTicks buffer is size-dependent, so it must always be recreated.
		entityStore.chunkArchetypeDirtyTicks[chunkId] = undefined // De-reference old one for GC
		// Also clear the structural change logs. Although their size is constant,
		// this ensures we get fresh buffers from the allocation call.
		entityStore.chunkAddedComponentMasks[chunkId] = undefined
		entityStore.chunkRemovedComponentMasks[chunkId] = undefined
		this._allocateChunkSharedMetadata(chunkId, capacity, this.componentTypesScratch, newComponentCount)

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

		// Fire hook for subscribers
		this.entityMaskManager.handleChunkCreated(chunkId, archetypeId)

		this.newlyCreatedChunks.push(chunkId)
		return chunkId
	}
	/**
	 * Allocates or re-allocates the shared metadata buffers for a chunk (dirty ticks, enableable masks, etc.).
	 * @param {number} chunkId The ID of the chunk.
	 * @param {number} capacity The capacity of the chunk.
	 * @param {Uint16Array} componentIdArray The sorted array of component IDs for the chunk's archetype.
	 * @private
	 */
	_allocateChunkSharedMetadata(chunkId, capacity, componentIdArray, componentCount) {
		// Allocate the per-component-type dirty tick buffer.
		const count = componentCount ?? componentIdArray.length
		const archetypeTicksBuffer = new SharedArrayBuffer(count * Uint32Array.BYTES_PER_ELEMENT)
		entityStore.chunkArchetypeDirtyTicks[chunkId] = new Uint32Array(archetypeTicksBuffer)
		entityStore.chunkArchetypeDirtyTicks[chunkId].fill(0)

		// Allocate the structural change (added/removed) log buffers.
		const structuralMasksSize = MASK_PARTS * Schema.DIRTY_HISTORY_LENGTH * BigUint64Array.BYTES_PER_ELEMENT
		const addedMasksBuffer = new SharedArrayBuffer(structuralMasksSize)
		const removedMasksBuffer = new SharedArrayBuffer(structuralMasksSize)
		entityStore.chunkAddedComponentMasks[chunkId] = new BigUint64Array(addedMasksBuffer)
		entityStore.chunkRemovedComponentMasks[chunkId] = new BigUint64Array(removedMasksBuffer)
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
		const indexInArchetype = entityStore.archetypeComponentIndexMapData[archetypeId * MAX_COMPONENTS + typeID]

		if (indexInArchetype !== 0xffff) {
			this._updateArchetypeDirtyTick(chunkId, indexInArchetype, currentTick)
		}
	}

	/**
	 * The public, immediate-mode API to mark a component within a chunk as dirty.
	 * This updates the chunk's "high-water mark" for the component, which allows
	 * reactive queries to efficiently detect that this chunk contains changes.
	 *
	 * This method does not perform any safety checks. If `componentTypeId` is not
	 * present in the chunk's archetype, it will result in a `TypeError`, which is
	 * the desired behavior to catch developer errors in a hot path.
	 *
	 * @param {number} chunkId The ID of the chunk containing the component.
	 * @param {number} componentTypeId The type ID of the component to mark.
	 * @param {number} tick The current game tick.
	 */
	markComponentDirty(chunkId, componentTypeId, tick) {
		const archetypeId = entityStore.chunkArchetypeIds[chunkId]
		const indexInArchetype = entityStore.archetypeComponentIndexMapData[archetypeId * MAX_COMPONENTS + componentTypeId]
		if (indexInArchetype !== 0xffff) {
			this._updateArchetypeDirtyTick(chunkId, indexInArchetype, tick)
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

	/**
	 * Creates a batch of entities from a serialized SoA payload. This is the new,
	 * unified, high-performance "memcpy" path for all entity creation.
	 * @param {number} archetypeId The target archetype for the entities.
	 * @param {import('../SystemManager/CommandBufferReader.js').CommandBufferReader} reader The command buffer reader.
	 * @param {number} payloadBaseOffset The starting offset of this command's payload.
	 * @param {number} currentTick The current game tick.
	 * @param {import('../SystemManager/PlaceholderMap.js').PlaceholderMap} resolutionMap The map for resolving placeholder IDs.
	 * @param {number} placeholderStartIndex The starting index for placeholder resolution.
	 * @private
	 */
	createEntitiesFromSoaBuffer(
		archetypeId,
		reader,
		payloadBaseOffset,
		currentTick,
		resolutionMap,
		placeholderStartIndex,
	) {
		reader.seek(payloadBaseOffset)

		// --- 1. Read General Info ---
		const count = reader.readU32()
		if (count === 0) return

		// The serializer adds padding to align the data block to 8 bytes.
		// The reader must skip this same amount of padding.
		const dataAlignment = 8
		const padding = (dataAlignment - (reader.offset % dataAlignment)) % dataAlignment
		reader.offset += padding

		// --- 2. Get Layout from Archetype ---
		const componentCount = this.getComponentTypeIDsForArchetype(archetypeId, this.componentTypesScratch)
		const componentTypeIDs = this.componentTypesScratch.subarray(0, componentCount)

		// --- Pre-create views for all source data to avoid allocation in the hot loop ---
		const sourcePropertyViews = []
		let dataOffset = reader.offset
		for (const typeId of componentTypeIDs) {
			const info = Schema.componentInfo[typeId]
			for (const propKey of info.propertyKeys) {
				const propInfo = info.properties[propKey];

				const bytesPerElement = propInfo.arrayConstructor.BYTES_PER_ELEMENT;

				// Align the data offset for the current property.
				const alignment = bytesPerElement;
				if (alignment > 0 && dataOffset % alignment !== 0) {
					dataOffset += alignment - (dataOffset % alignment);
				}
				const sourceView = new propInfo.arrayConstructor(reader.buffer, dataOffset, count);
				sourcePropertyViews.push(sourceView);
				dataOffset += count * bytesPerElement;
			}
		}
		const totalDataSize = dataOffset - reader.offset

		// --- 3. Bulk Allocate Space ---
		const blockCount = this._allocateSpaceForNEntities(archetypeId, count)

		// --- 4. Create Entities and Blit Data ---
		let entitiesCreated = 0
		for (let i = 0; i < blockCount; i++) {
			const chunkId = this._allocatedBlockChunkIds[i]
			const startEntityIndexInChunk = this._allocatedBlockStartIndices[i]
			const batchSize = this._allocatedBlockCounts[i]

			// --- Log structural change for `added:` queries (once per chunk) ---
			const archetypeMaskOffset = archetypeId * MASK_PARTS
			const addedMask = entityStore.archetypeMasks.subarray(archetypeMaskOffset, archetypeMaskOffset + MASK_PARTS)
			this._logStructuralChange(chunkId, addedMask, null, currentTick)

			// Create entity IDs and update their locations for this block
			for (let j = 0; j < batchSize; j++) {
				const entityIndexInAll = entitiesCreated + j
				const entityId = this._createEntityId()

				resolutionMap.set(placeholderStartIndex + entityIndexInAll, entityId)

				// We don't need _addEntityToChunk anymore, space is pre-allocated.
				const indexInChunk = startEntityIndexInChunk + j
				entityStore.chunkComponentData[chunkId].entities[indexInChunk] = entityId
				const entityArrayIndex = Number(entityId & 0xffffffffn)
				entityStore.entityPackedLocations[entityArrayIndex] = (archetypeId << 16) | chunkId
				entityStore.entityIndicesInChunk[entityArrayIndex] = indexInChunk
			}

			// --- Bulk Copy Data (memcpy) ---
			let viewIndex = 0
			for (const typeId of componentTypeIDs) {
				const destSoaArrays = entityStore.chunkComponentData[chunkId][typeId]

				for (const propKey of Schema.componentInfo[typeId].propertyKeys) {
					const destArray = destSoaArrays[propKey]
					const fullSourceView = sourcePropertyViews[viewIndex++]
					const propMap = this.entityMaskManager.initialStateMap.get(typeId)

					// --- NEW LOGIC: Check for initial state mask ---
					if (propMap) {
						const valueMap = propMap.get(propKey)
						if (valueMap) {
							// This path is slower as it requires per-entity checks, but it's necessary
							// for initial state masks. It only runs for components with such masks.
							for (let k = 0; k < batchSize; k++) {
								const indexInChunk = startEntityIndexInChunk + k
								const value = fullSourceView[entitiesCreated + k]
								destArray[indexInChunk] = value
								const maskId = valueMap.get(value)
								if (maskId !== undefined) {
									this.entityMaskManager.setBit(maskId, chunkId, indexInChunk)
								}
							}
							continue // Skip the bulk copy below
						}
					}
					// Copy the slice of the source data corresponding to this batch
					this._copyTypedArrayBlock(destArray, startEntityIndexInChunk, fullSourceView, entitiesCreated, batchSize)
				}
			}

			// --- Handle Dirty Tracking ---
			for (const typeId of componentTypeIDs) {
				this.markComponentDirty(chunkId, typeId, currentTick)
			}

			// NEW (V2): Use the archetype's pre-cached list of trackable components.
			const trackableIds = entityStore.archetypeTrackableComponentIds[archetypeId]
			if (trackableIds.length > 0) {
				const entities = entityStore.chunkComponentData[chunkId].entities
				for (let j = 0; j < batchSize; j++) {
					const entityId = entities[startEntityIndexInChunk + j]
					for (const typeId of trackableIds) {
						const modifiedMaskId = this.entityMaskManager.componentToModifiedMaskId.get(typeId)
						this.entityMaskManager.fireEventById(modifiedMaskId, entityId, currentTick)
					}
				}
			}

			entitiesCreated += batchSize
		}

		// Advance the reader past all the data blocks
		reader.offset += totalDataSize
	}

	/**
	 * Finds the target archetype ID after applying a set of component additions and removals.
	 * @param {number} sourceArchetypeId The starting archetype.
	 * @param {BigUint64Array} addedMask The bitmask of components to add.
	 * @param {BigUint64Array} removedMask The bitmask of components to remove.
	 * @returns {number} The target archetype ID.
	 */
	findArchetypeWithChanges(sourceArchetypeId, addedMask, removedMask) {
		// Use the pre-allocated temporary mask to avoid allocations.
		const sourceMaskOffset = sourceArchetypeId * MASK_PARTS
		for (let i = 0; i < MASK_PARTS; i++) {
			this.tempArchetypeMask[i] = entityStore.archetypeMasks[sourceMaskOffset + i]
		}

		// Apply changes to the temporary mask.
		for (let i = 0; i < MASK_PARTS; i++) {
			this.tempArchetypeMask[i] = (this.tempArchetypeMask[i] | addedMask[i]) & ~removedMask[i]
		}

		return this.getArchetypeByMask(this.tempArchetypeMask)
	}

	/**
	 * Internal helper to set component data at a known location.
	 * @private
	 */
	_setComponentDataFromAosBufferAtLocation(
		chunkId,
		indexInChunk,
		entityId,
		typeId,
		reader,
		payloadBaseOffset,
		resolutionMap,
		currentTick,
		isSilent,
	) {
		// Payload format: [trackableCount, trackableIds..., dataBlob]
		const trackableCount = reader.view.getUint8(payloadBaseOffset)
		const dataBlobOffset = payloadBaseOffset + 1 + trackableCount * 2

		this._writeComponentDataFromBuffer(chunkId, indexInChunk, typeId, reader.view, dataBlobOffset, resolutionMap)

		if (!isSilent) {
			// Mark the component itself as dirty for broad-phase queries.
			this.markComponentDirty(chunkId, typeId, currentTick)

			// Fire the "modified" event if the component is trackable.
			const modifiedMaskId = this.entityMaskManager.componentToModifiedMaskId.get(typeId)
			if (modifiedMaskId !== undefined) {
				this.entityMaskManager.fireEventById(entityId, modifiedMaskId, currentTick)
			}
		}
	}
	/**
	 * Sets the data for a single component on an entity from a command buffer payload.
	 * Internal helper to set a batch of component data at a known location.
	 * @private
	 */
	_setComponentsDataFromSoaBufferAtLocation(
		chunkId,
		indexInChunk,
		entityId,
		archetypeId,
		reader,
		payloadBaseOffset,
		resolutionMap,
		currentTick,
		isSilent,
		isAddComponent = false,
	) {
		const componentNamesForLog = this.getComponentTypeIDsForArchetype(archetypeId, this.componentTypesScratch)
		const componentNames = Array.from(this.componentTypesScratch.subarray(0, componentNamesForLog))
			.map(id => Schema.componentNames[id])
			.join(', ')

		reader.seek(payloadBaseOffset)

		// --- 1. Read Header ---
		const count = reader.readU32() // Should be 1
		if (count !== 1) {
			console.warn(`[EntityManager] setComponents called with a payload count of ${count}. Expected 1.`)
			// Even if count is not 1, we proceed assuming it is, as this is a single-entity operation.
		}

		// The serializer adds padding to align the data block to 8 bytes.
		// The reader must skip this same amount of padding.
		const dataAlignment = 8
		const padding = (dataAlignment - (reader.offset % dataAlignment)) % dataAlignment
		reader.offset += padding

		// --- 2. Get Layout from Archetype ---
		const componentCount = this.getComponentTypeIDsForArchetype(archetypeId, this.componentTypesScratch)
		const componentTypeIDs = this.componentTypesScratch.subarray(0, componentCount)

		// --- 3. Blit Data (memcpy-style) ---
		let dataBlockOffset = reader.offset
		for (const typeId of componentTypeIDs) {
			const info = Schema.componentInfo[typeId]
			const destSoaArrays = entityStore.chunkComponentData[chunkId][typeId]
			const propMap = this.entityMaskManager.initialStateMap.get(typeId)
			const hasEntityRef = info.propertyKeys.some(pk => info.properties[pk].type === 'entity')

			// The property-by-property path is needed for entity ref resolution OR state mask updates.
			const needsSlowPath = propMap || (hasEntityRef && resolutionMap)

			if (needsSlowPath) {
				// SLOW PATH: This component has entity refs to resolve or state masks to update.
				for (const propKey of info.propertyKeys) {
					const propInfo = info.properties[propKey]
					const bytesPerElement = propInfo.arrayConstructor.BYTES_PER_ELEMENT

					// Align the data offset for the current property.
					const alignment = bytesPerElement
					if (alignment > 0 && dataBlockOffset % alignment !== 0) {
						dataBlockOffset += alignment - (dataBlockOffset % alignment)
					}

					// --- Get old value if this property has a mask ---
					const valueMap = propMap?.get(propKey)
					let oldValue
					if (valueMap && !isAddComponent) {
						oldValue = destSoaArrays[propKey][indexInChunk]
					}

					let newValue
					if (propInfo.type === 'entity' && resolutionMap) {
						const placeholderId = reader.view.getBigUint64(dataBlockOffset, true)
						if (placeholderId >> 63n === 1n) {
							const placeholderIndex = Number(placeholderId & 0xffffffffn)
							const resolvedId = resolutionMap.get(placeholderIndex)
							// Check for the "doomed" bit (bit 62).
							if ((resolvedId & (1n << 62n)) !== 0n) {
								newValue = 0n // The placeholder was destroyed in the same frame. Resolve to null.
							} else {
								newValue = resolvedId ?? 0n // If not doomed, use the ID (or 0n if not found).
							}
						} else {
							newValue = placeholderId // It's a regular entity ID.
						}
					} else {
						newValue = this._readValue(reader.view, dataBlockOffset, propInfo.type)
					}
					destSoaArrays[propKey][indexInChunk] = newValue
					dataBlockOffset += bytesPerElement * count // count is 1

					// If this property drives a state mask, update the masks now.
					if (valueMap && !isSilent && (isAddComponent || oldValue !== newValue)) {
						if (!isAddComponent) {
							const oldMaskId = valueMap.get(oldValue)
							if (oldMaskId !== undefined) {
								this.entityMaskManager.clearBit(oldMaskId, chunkId, indexInChunk)
							}
						}
						const newMaskId = valueMap.get(newValue)
						if (newMaskId !== undefined) {
							this.entityMaskManager.setBit(newMaskId, chunkId, indexInChunk)
						}
					}
				}
			} else {
				// FAST PATH: No entity references. bulk copy.
				for (const propKey of info.propertyKeys) {
					const propInfo = info.properties[propKey]
					const bytesPerElement = propInfo.arrayConstructor.BYTES_PER_ELEMENT

					// Align the data offset for the current property.
					const alignment = bytesPerElement;
					if (alignment > 0 && dataBlockOffset % alignment !== 0) { // prettier-ignore
						dataBlockOffset += alignment - (dataBlockOffset % alignment);
					}

					const sourceView = new propInfo.arrayConstructor(reader.buffer, dataBlockOffset, count) // count is 1
					this._copyTypedArrayBlock(destSoaArrays[propKey], indexInChunk, sourceView, 0, count)
					dataBlockOffset += bytesPerElement * count // count is 1
				}
			}
		}

		// --- 4. Handle Dirty Tracking ---
		if (!isSilent) {
			// Mark all components in the payload as dirty for broad-phase queries.
			for (const typeId of componentTypeIDs) {
				this.markComponentDirty(chunkId, typeId, currentTick)

			}
			// Use the archetype's pre-cached list to fire narrow-phase "modified" events.
			const trackableIds = entityStore.archetypeTrackableComponentIds[archetypeId]

			for (const typeId of trackableIds) {
				const modifiedMaskId = this.entityMaskManager.componentToModifiedMaskId.get(typeId)
				this.entityMaskManager.fireEventById(modifiedMaskId, entityId, currentTick)
			}
		}
	}

	/**
	 * @private
	 * Helper to read a value from a DataView with the correct type.
	 */
	_readValue(view, offset, type) {
		const constructor = Schema.TYPED_ARRAY_MAP[type]
		if (!constructor) {
			throw new Error(`EntityManager: Unknown property type for reading: ${type}`)
		}

		switch (constructor) {
			case BigUint64Array:
				return view.getBigUint64(offset, true)
			case BigInt64Array:
				return view.getBigInt64(offset, true)
			case Float64Array:
				return view.getFloat64(offset, true)
			case Float32Array:
				return view.getFloat32(offset, true)
			case Uint32Array:
				return view.getUint32(offset, true)
			case Int32Array:
				return view.getInt32(offset, true)
			case Uint16Array:
				return view.getUint16(offset, true)
			case Int16Array:
				return view.getInt16(offset, true)
			case Uint8Array:
				return view.getUint8(offset)
			case Int8Array:
				return view.getInt8(offset)
			default:
				throw new Error(`EntityManager: Unsupported constructor for reading: ${constructor.name}`)
		}
	}

	/**
	 * Immediate-mode method to set the data for a batch of components.
	 * @param {bigint} entityId The entity to modify.
	 * @param {object} payload The compiled payload from PayloadCompiler.
	 * @param {number} currentTick The current game tick.
	 * @returns {boolean} True on success.
	 */
	setComponentsDataImmediate(entityId, payload, currentTick, isSilent = false) {
		if (!this.isEntityActive(entityId)) return false
		// 1. Get location data without allocating an object.
		const entityIndex = Number(entityId & 0xffffffffn)
		const packedLocation = entityStore.entityPackedLocations[entityIndex]
		if (packedLocation === 0) return false // Entity not in a chunk.

		const chunkId = packedLocation & 0xffff
		const indexInChunk = entityStore.entityIndicesInChunk[entityIndex]

		// 2. Use the reusable immediate-mode buffer.
		const buffer = this.immediateBuffer
		buffer.reset()

		const count = 1 // Immediate mode always sets for a single entity.

		// Write header
		buffer.writeU32(count)

		// Add padding
		const dataAlignment = 8
		const padding = (dataAlignment - (buffer.offset % dataAlignment)) % dataAlignment
		for (let i = 0; i < padding; i++) {
			buffer.writeU8(0)
		}

		// Write data blocks by copying slices
		for (const item of payload.layout) {
			const sourceBuffer = payload.buffers[item.componentName][item.propKey]
			// This allocation is a minor trade-off for using the existing SoA-based executor method.
			// It's a small, short-lived view for a single entity's property.
			const sliceView = new Uint8Array(sourceBuffer.buffer, sourceBuffer.byteOffset, count * item.bytesPerElement)
			buffer.writeBuffer(sliceView)
		}

		// 3. Use the reusable reader.
		const reader = this.immediateReader
		reader.setBuffer(buffer)

		// 4. Call the executor with the non-allocating location data.
		this._setComponentsDataFromSoaBufferAtLocation(
			chunkId,
			indexInChunk,
			entityId,
			payload.archetypeId,
			reader,
			0,
			null,
			currentTick,
			isSilent,
			false, // isAddComponent
		)
		return true
	}
}
export const entityManager = new EntityManager()
