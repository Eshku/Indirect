const { Chunk } = await import(`${PATH_ECS}/ArchetypeManager/Chunk.js`)
import * as Schema from '../ComponentManager/ComponentSchema.js'
/**
 * Manages all entities, archetypes, and their component data.
 *
 * This class is the heart of ECS, owning core data structures that track
 * every entity and its associated data. It provides methods for all structural
 * changes: creating/destroying entities and adding/removing components.
 *
 * --- Generational Entity IDs ---
 *
 * To solve "stale ID" problem (where an old entity ID could be recycled and
 * incorrectly refer to a new entity), we use generational entity IDs. Each ID is a
s * `BigInt` (64-bit unsigned integer) composed of two parts:
 *
 * | Part       | Bits    | Description                                            |
 * |------------|---------|--------------------------------------------------------|
 * | Generation | 31 bits | A counter that increments each time an index is reused.|
 * | Index      | 32 bits | A stable index into internal entity arrays.        |
 * | Placeholder| 1 bit   | (MSB) A flag to mark ID as a temporary placeholder.|
 *
 * - **Index (lower 32 bits):** A direct, reusable index into arrays like
 *   `entityLocations` and `entityVersion`.
 * - **Generation (middle 31 bits):** When an entity at `index` is destroyed, its
 *   generation counter is incremented. next entity created at that `index` will
 *   have new generation. An old ID with a stale generation will fail validation.
 * - **Placeholder Flag (bit 63):** Most significant bit is reserved. If set,
 *   it marks ID as a "placeholder," a temporary ID created by a worker thread
 *   that will be resolved to a real entity ID by main thread. This is a
 *   critical feature for enabling parallel entity creation.
 *
 * --- Data Lookup Flow ---
 *
 * 1.  `entityId` -> `index` (from lower 32 bits of ID)
 * 2.  `isEntityActive(entityId)` validates ID against `entityVersion[index]`.
 * 3.  `entityLocations[index]` -> `{ archetypeId, chunk, indexInChunk }`
 * 4.  `chunk.componentArrays[typeID].x[indexInChunk]` -> Direct component data access.
 */

const DEFAULT_CHUNK_CAPACITY = 256
export const MAX_ARCHETYPES = 4096

export class EntityManager {
	constructor() {
		// --- Entity Management ---
		// Maps an entity's index to its full, versioned ID for validation.
		this.entityVersion = []
		// Maps an entity's index to its data location: { archetypeId, chunk, indexInChunk }.
		this.entityLocations = []
		// Stores the generation counter for each entity index.
		this.generations = []
		// A pool of recycled entity indices for reuse.
		this.freeIndices = []
		this.nextEntityIndex = 1

		// --- Archetype Management ---
		this.archetypeLookup = new Map()
		this.nextArchetype = 0
		this.archetypeMasks = []
		this.archetypeComponentTypeIDs = []
		this.archetypeChunks = []
		this.archetypeTransitions = []
		this.archetypeLastNonFullChunk = [] // Tracks last chunk that wasn't full for faster insertions.

		// --- Manager References ---
		this.queryManager = null
		this.componentManager = null
		this.systemManager = null
		this.prefabManager = null
	}

	async init(ecs) {
		// Direct references, no more 'store' or 'archetypeManager'
		this.queryManager = ecs.queryManager
		this.componentManager = ecs.componentManager
		this.systemManager = ecs.systemManager
		this.prefabManager = ecs.prefabManager // Still needed for prefab logic
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
	addComponent(entityId, componentTypeId, data) {
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

		const sourceArchetypeMask = this.archetypeMasks[sourceArchetypeId]
		const targetArchetypeMask = sourceArchetypeMask | this.componentManager.componentBitFlags[componentTypeId]
		const targetArchetypeId = this.getArchetypeByMask(targetArchetypeMask)

		const componentsToAssign = new Map([[componentTypeId, data]]) // `data` is binary payload

		return this._moveEntityToNewArchetype(entityId, sourceArchetypeId, targetArchetypeId, componentsToAssign)
	}

	/**
	 * Removes a component from an entity immediately.
	 * @param {bigint} entityId - entity to modify.
	 * @param {number} componentTypeId - type ID of component to remove.
	 * @returns {boolean} True on success.
	 */
	removeComponent(entityId, componentTypeId) {
		if (!this.isEntityActive(entityId)) return false
		const sourceArchetypeId = this.getArchetypeForEntity(entityId)
		if (!this.hasComponentType(sourceArchetypeId, componentTypeId)) return false
		const sourceArchetypeMask = this.archetypeMasks[sourceArchetypeId]
		const targetArchetypeMask = sourceArchetypeMask & ~this.componentManager.componentBitFlags[componentTypeId]
		const targetArchetypeId = this.getArchetypeByMask(targetArchetypeMask)
		return this._moveEntityToNewArchetype(entityId, sourceArchetypeId, targetArchetypeId, new Map())
	}

	/**
	 * Destroys a single entity, recycling its ID.
	 * @param {bigint} entityID - entity to destroy.
	 * @returns {boolean} True if entity was active and destroyed.
	 */
	destroyEntity(entityID) {
		if (!this.isEntityActive(entityID)) return false

		const index = Number(entityID & 0xffffffffn)
		const location = this.entityLocations[index]
		if (location) {
			this._removeEntity(location.archetypeId, entityID, location)
		}
		this.entityVersion[index] = undefined
		this.entityLocations[index] = undefined
		this.generations[index]++ // Increment generation on destruction
		this.freeIndices.push(index)

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
				const location = this.entityLocations[index]
				if (location) {
					if (!entitiesByArchetype.has(location.archetypeId)) entitiesByArchetype.set(location.archetypeId, [])
					entitiesByArchetype.get(location.archetypeId).push(entityId)
				} else {
					// Handle entities that exist but have no components (and thus no location).
					this.freeIndices.push(index)
					this.generations[index]++
					this.entityVersion[index] = undefined
					// No entityLocations to clear.
				}
			}
		}

		// --- Pass 2: Perform batched removals and invalidate IDs ---
		for (const [archetype, ids] of entitiesByArchetype.entries()) {
			this._removeEntitiesBatch(archetype, ids)
			for (const entityId of ids) {
				const index = Number(entityId & 0xffffffffn)
				this.freeIndices.push(index)
				this.generations[index]++
				this.entityVersion[index] = undefined
				this.entityLocations[index] = undefined
			}
		}
		return true
	}

	/**
	 * Destroys all entities within a given set of chunks.
	 * @param {Chunk[]} chunks - An array of chunks whose entities should be destroyed.
	 */
	destroyEntitiesInChunks(chunks) {
		for (const chunk of chunks) {
			if (chunk.size === 0) continue

			const entitiesToDestroy = chunk.entities.subarray(0, chunk.size)
			for (const entityId of entitiesToDestroy) {
				const index = Number(entityId & 0xffffffffn)
				this.freeIndices.push(index)
				this.generations[index]++
				this.entityLocations[index] = undefined
				this.entityVersion[index] = undefined // Invalidate old version ID.
			}
			this._removeEntitiesBatch(chunk.archetype, chunk.entities.subarray(0, chunk.size))
		}
	}

	destroyAllEntities() {
		// This is a full reset. We can safely clear everything.
		this.clearAllArchetypes() // Removes all chunks
		this.clearAll() // Resets all entity-related arrays and counters
		this.generations = [] //  Reset generation counters
	}

	isEntityActive(entityID) {
		if (entityID >> 63n === 1n) return false
		if (typeof entityID !== 'bigint') return false
		const index = Number(entityID & 0xffffffffn)
		return this.entityVersion[index] === entityID
	}

	/**
	 * Gets archetype ID for a given entity.
	 * @param {bigint} entityId - entity ID.
	 * @returns {number | undefined} archetype (ID), or undefined if entity has no archetype.
	 */
	getArchetypeForEntity(entityId) {
		const index = Number(entityId & 0xffffffffn)
		return this.entityLocations[index]?.archetypeId
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
	_moveEntityToNewArchetype(entityId, sourceArchetypeId, targetArchetypeId, componentsToAssign) {
		const entityIndex = Number(entityId & 0xffffffffn)
		const sourceLocation = this.entityLocations[entityIndex]
		if (!sourceLocation) return false

		const { chunk: sourceChunk, indexInChunk: sourceIndex } = sourceLocation

		// 1. Allocate space in target archetype and update entity's primary records.
		const targetChunk = this._findOrCreateChunk(targetArchetypeId)
		const targetIndex = targetChunk.addEntity(entityId)
		this.entityLocations[entityIndex] = {
			archetypeId: targetArchetypeId,
			chunk: targetChunk,
			indexInChunk: targetIndex,
		}

		// 2. Copy existing component data from old chunk to new one.
		const copyPlan = this._getOrCreateCopyPlan(sourceArchetypeId, targetArchetypeId)
		// copy plan now contains exact, flattened list of properties to blit.
		// This is much faster as it avoids inner loop and dynamic lookups.
		for (const { typeID, propKey } of copyPlan.toCopy) {
			const sourceArray = sourceChunk.componentArrays[typeID][propKey]
			const targetArray = targetChunk.componentArrays[typeID][propKey]
			targetArray[targetIndex] = sourceArray[sourceIndex]
		}

		// 3. Initialize newly added components using their binary payloads.
		for (const [typeID, data] of componentsToAssign.entries()) {
			const dataView = new DataView(data) // data is now raw ArrayBuffer
			this._writeComponentDataFromBuffer(targetChunk, targetIndex, typeID, dataView, 0)
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
		if (this.archetypeLookup.has(archetypeMask)) {
			return this.archetypeLookup.get(archetypeMask)
		}

		const id = this.nextArchetype++
		if (id >= MAX_ARCHETYPES) {
			throw new Error(`EntityManager: Maximum number of archetypes (${MAX_ARCHETYPES}) reached.`)
		}

		if (!sortedTypeIDs) {
			sortedTypeIDs = this.getComponentTypesFromMask(archetypeMask)
		}

		this.archetypeMasks[id] = archetypeMask
		this.archetypeComponentTypeIDs[id] = new Set(sortedTypeIDs)
		this.archetypeChunks[id] = []
		this.archetypeTransitions[id] = { add: {}, remove: {} }
		this.archetypeLastNonFullChunk[id] = 0

		this.archetypeLookup.set(archetypeMask, id)
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
		return this.archetypeComponentTypeIDs[archetype]?.has(componentTypeID)
	}

	getEntityLocation(entityId) {
		const location = this.entityLocations[Number(entityId & 0xffffffffn)]
		return location?.archetypeId !== undefined ? location : undefined
	}

	clearAll() {
		this.nextEntityIndex = 1
		this.freeIndices.length = 0
		this.entityLocations.length = 0
		this.generations.length = 0
		this.entityVersion.length = 0
	}

	clearAllArchetypes() {
		this.archetypeLookup.clear()
		this.nextArchetype = 0
		this.archetypeMasks.length = 0
		this.archetypeComponentTypeIDs.length = 0
		this.archetypeChunks.length = 0
		this.archetypeTransitions.length = 0
		this.archetypeLastNonFullChunk.length = 0
	}

	_blitComponentDataFromBinary(chunk, typeID, destIndices, dataOffsets, dataLengths, reader, currentTick) {
		chunk.lastDirtyTick = currentTick
		const batchSize = destIndices.length

		for (let i = 0; i < batchSize; i++) {
			const destIndex = destIndices[i]
			const sourceOffset = dataOffsets[i]
			const sourceLength = dataLengths[i]
			const sourceView = new DataView(reader.buffer, sourceOffset, sourceLength)
			this._writeComponentDataFromBuffer(chunk, destIndex, typeID, sourceView, 0)
		}

		for (let i = 0; i < batchSize; i++) {
			chunk.dirtyTicksArrays[typeID][destIndices[i]] = currentTick
		}
	}

	_fillComponentDataFromBuffer(chunk, typeID, sourceView, currentTick) {
		const info = Schema.componentInfo[typeID]
		// This loop is intentionally simple for JIT optimization.
		chunk.lastDirtyTick = currentTick
		for (let i = 0; i < chunk.size; i++) {
			this._writeComponentDataFromBuffer(chunk, i, typeID, sourceView, 0)
		}
		if (info.byteSize > 0) {
			chunk.dirtyTicksArrays[typeID].fill(currentTick, 0, chunk.size)
		}
	}

	addEntityFromBinarySoAPayload(archetype, entityId, binarySoAPayload, currentTick) {
		const chunk = this._findOrCreateChunk(archetype)
		const indexInChunk = chunk.addEntity(entityId)
		this.entityLocations[Number(entityId & 0xffffffffn)] = { archetypeId: archetype, chunk, indexInChunk }
		chunk.lastDirtyTick = currentTick

		const sourceView = new DataView(binarySoAPayload)
		let componentBaseOffset = 0

		for (const typeID of this.archetypeComponentTypeIDs[archetype]) {
			const info = Schema.componentInfo[typeID]
			const alignment = info.alignment
			if (alignment > 0 && componentBaseOffset % alignment !== 0) {
				componentBaseOffset += alignment - (componentBaseOffset % alignment)
			}

			this._writeComponentDataFromBuffer(chunk, indexInChunk, typeID, sourceView, componentBaseOffset)
			componentBaseOffset += info.byteSize

			chunk.dirtyTicksArrays[typeID][indexInChunk] = currentTick
		}
	}

	_addIdenticalEntitiesBatch(archetype, entities, payload, currentTick) {
		const count = entities.length
		if (count === 0) return

		let entityCursor = 0

		while (entityCursor < count) {
			const chunk = this._findOrCreateChunk(archetype)

			const spaceInChunk = chunk.capacity - chunk.size
			chunk.lastDirtyTick = currentTick
			const entitiesToAddInChunk = Math.min(count - entityCursor, spaceInChunk)
			const startIndexInChunk = chunk.size
			const endIndexInChunk = startIndexInChunk + entitiesToAddInChunk

			const entitiesSlice = entities.slice(entityCursor, entityCursor + entitiesToAddInChunk)
			chunk.entities.set(entitiesSlice, startIndexInChunk)

			for (let i = 0; i < entitiesToAddInChunk; i++) {
				const entityId = entitiesSlice[i]
				this.entityLocations[Number(entityId & 0xffffffffn)] = {
					archetypeId: archetype,
					chunk,
					indexInChunk: startIndexInChunk + i,
				}
			}

			const aosView = new DataView(payload)
			let aosOffset = 0

			const componentTypeIDs = this.archetypeComponentTypeIDs[archetype]
			for (const typeID of componentTypeIDs) {
				const info = Schema.componentInfo[typeID]
				if (info.byteSize === 0) continue

				const destSoAArrays = chunk.componentArrays[typeID]

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
				chunk.dirtyTicksArrays[typeID].fill(currentTick, startIndexInChunk, endIndexInChunk)
			}

			chunk.size += entitiesToAddInChunk
			entityCursor += entitiesToAddInChunk
		}
	}

	_getOrCreateCopyPlan(sourceArchetypeId, targetArchetypeId) {
		const sourceTransitions = this.archetypeTransitions[sourceArchetypeId]
		if (sourceTransitions.add[targetArchetypeId]) {
			return sourceTransitions.add[targetArchetypeId]
		}

		const sourceComponents = this.archetypeComponentTypeIDs[sourceArchetypeId]
		const targetComponents = this.archetypeComponentTypeIDs[targetArchetypeId]

		const plan = {
			toCopy: [], // Will now be an array of { typeID, propKey }
			toInitialize: [],
		}

		for (const typeID of targetComponents) {
			if (sourceComponents.has(typeID)) {
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
			const chunk = this._findOrCreateChunk(targetArchetype)

			chunk.lastDirtyTick = currentTick
			const spaceInChunk = chunk.capacity - chunk.size
			const entitiesToAddInChunk = Math.min(count - entityCursor, spaceInChunk)
			const startIndexInChunk = chunk.size

			// --- Batch Add Entities and Update Mappings ---
			for (let i = 0; i < entitiesToAddInChunk; i++) {
				const overallIndex = entityCursor + i
				const targetIndex = startIndexInChunk + i
				const entityId = entityIds[overallIndex]

				chunk.entities[targetIndex] = entityId
				const newLocation = { chunk, indexInChunk: targetIndex }
				this.entityLocations[Number(entityId & 0xffffffffn)] = { archetypeId: targetArchetype, ...newLocation }
				newLocationsMap.set(entityId, newLocation)
			}

			// --- Batch Copy Component Data (SoA style) ---
			// loop per-property, not per-entity.
			for (const { typeID, propKey } of copyPlan.toCopy) {
				const targetArray = chunk.componentArrays[typeID][propKey]
				const dirtyTicksArray = chunk.dirtyTicksArrays[typeID]

				for (let i = 0; i < entitiesToAddInChunk; i++) {
					const overallIndex = entityCursor + i
					const targetIndex = startIndexInChunk + i
					const { chunk: sourceChunk, indexInChunk: sourceIndex } = sourceLocations[overallIndex]
					const sourceArray = sourceChunk.componentArrays[typeID][propKey]
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
					this._writeComponentDataFromBuffer(chunk, destIndex, typeID, sourceView, 0)
					chunk.dirtyTicksArrays[typeID][destIndex] = currentTick
				}
			}
			chunk.size += entitiesToAddInChunk
			entityCursor += entitiesToAddInChunk
		}
	}

	_removeEntitiesBatch(archetype, entityIds) {
		const componentTypeIDs = this.archetypeComponentTypeIDs[archetype]
		const removalsByChunk = new Map()
		const chunks = this.archetypeChunks[archetype]

		for (const entityId of entityIds) {
			const location = this.entityLocations[Number(entityId & 0xffffffffn)]
			if (location) {
				const { chunk, indexInChunk } = location
				if (!removalsByChunk.has(chunk)) {
					removalsByChunk.set(chunk, [])
				}
				removalsByChunk.get(chunk).push(indexInChunk)
			}
		}

		for (const [chunk, indicesToRemove] of removalsByChunk.entries()) {
			indicesToRemove.sort((a, b) => b - a)
			const swappedMappings = this._removeEntitiesFromChunk(chunk, indicesToRemove, componentTypeIDs)

			for (const [swappedEntityId, newIndex] of swappedMappings.entries()) {
				const swappedLocation = this.entityLocations[Number(swappedEntityId & 0xffffffffn)]
				if (swappedLocation) swappedLocation.indexInChunk = newIndex
			}

			if (chunk.size === 0) {
				const chunkIndex = chunks.indexOf(chunk)
				if (chunkIndex > -1) {
					chunks.splice(chunkIndex, 1)
					if (this.archetypeLastNonFullChunk[archetype] >= chunkIndex) {
						this.archetypeLastNonFullChunk[archetype]--
					}
				}
			}
		}
	}

	_removeEntitiesFromChunk(chunk, sortedIndicesToRemove, componentTypeIDs) {
		const numToRemove = sortedIndicesToRemove.length
		if (numToRemove === 0) return new Map()

		const swappedMappings = new Map()
		let lastIndex = chunk.size - 1

		for (const indexToRemove of sortedIndicesToRemove) {
			if (indexToRemove > lastIndex) continue

			const isLastElement = indexToRemove === lastIndex

			if (!isLastElement) {
				const swappedEntityId = chunk.entities[lastIndex]
				chunk.entities[indexToRemove] = swappedEntityId
				swappedMappings.set(swappedEntityId, indexToRemove)

				for (const typeID of componentTypeIDs) {
					const propArrays = chunk.componentArrays[typeID]
					for (const propKey in propArrays) {
						propArrays[propKey][indexToRemove] = propArrays[propKey][lastIndex]
					}
					chunk.dirtyTicksArrays[typeID][indexToRemove] = chunk.dirtyTicksArrays[typeID][lastIndex]
				}
			}
			lastIndex--
		}

		chunk.size -= numToRemove
		return swappedMappings
	}

	_createEntityId() {
		const index = this.freeIndices.length > 0 ? this.freeIndices.pop() : this.nextEntityIndex++

		if (index >= this.entityLocations.length) {
			const newLength = index + 1
			this.generations.length = newLength
			this.generations.fill(0, this.entityLocations.length)
			this.entityVersion.length = newLength
			this.entityLocations.length = newLength
		}

		const generation = this.generations[index]
		const entityId = (BigInt(generation) << 32n) | BigInt(index)
		this.entityVersion[index] = entityId

		return entityId
	}

	_removeEntity(archetype, entityId, location) {
		if (!location) {
			return
		}

		const { chunk, indexInChunk } = location // location is now passed in
		const componentTypeIDs = this.archetypeComponentTypeIDs[archetype]
		const swappedMappings = this._removeEntitiesFromChunk(chunk, [indexInChunk], componentTypeIDs)

		for (const [swappedEntityId, newIndex] of swappedMappings.entries()) {
			const swappedLocation = this.entityLocations[Number(swappedEntityId & 0xffffffffn)]
			if (swappedLocation) swappedLocation.indexInChunk = newIndex
		}

		if (chunk.size === 0) {
			const chunks = this.archetypeChunks[archetype]
			const chunkIndex = chunks.indexOf(chunk)
			if (chunkIndex > -1) {
				chunks.splice(chunkIndex, 1)
				if (this.archetypeLastNonFullChunk[archetype] >= chunkIndex) {
					this.archetypeLastNonFullChunk[archetype]--
				}
			}
		}
	}

	_findOrCreateChunk(archetypeId) {
		const chunks = this.archetypeChunks[archetypeId]
		if (!chunks) return null // Archetype might not exist yet
		const lastNonFullChunkIndex = this.archetypeLastNonFullChunk[archetypeId] || 0

		// Start search from last known non-full chunk
		for (let i = 0; i < chunks.length; i++) {
			const chunkIndex = (lastNonFullChunkIndex + i) % chunks.length
			const chunk = chunks[chunkIndex]
			if (chunk && !chunk.isFull()) {
				this.archetypeLastNonFullChunk[archetypeId] = chunkIndex
				return chunk
			}
		}

		// If no non-full chunk is found, create a new one
		const componentTypeIDs = this.archetypeComponentTypeIDs[archetypeId]
		const newChunk = new Chunk(archetypeId, DEFAULT_CHUNK_CAPACITY, componentTypeIDs)
		chunks.push(newChunk)
		this.archetypeLastNonFullChunk[archetypeId] = chunks.length - 1
		return newChunk
	}

	_writeComponentDataFromBuffer(chunk, indexInChunk, typeID, sourceView, componentBaseOffset) {
		const info = Schema.componentInfo[typeID]
		const destSoaArrays = chunk.componentArrays[typeID]

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
}
