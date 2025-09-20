/**
 * Manages archetypes, which are unique combinations of components.
 *
 * ---
 *
 * ### Architectural Philosophy: Immortal Archetype Definitions
 *
 * A core performance principle of this ECS is that archetype definitions, once created,
 * are considered "immortal". They are never deleted, even if they become empty.
 *
 * #### The Problem: Archetype Churn
 *
 * A naive approach would be to delete an archetype as soon as its last entity is removed.
 * However, this creates a significant performance bottleneck known as "archetype churn":
 *
 * 1.  **Deletion Cost:** When an archetype is deleted, the `ArchetypeManager` must notify the
 *     `QueryManager`. The `QueryManager` then has to iterate through **every active query**
 *     in the engine to remove the deleted archetype from their lists of matching archetypes.
 *
 * 2.  **Re-creation Cost:** If an entity with the same component signature is created shortly
 *     after (a very common pattern, e.g., spawning new enemies of the same type that were
 *     just killed), a new archetype must be created. This again forces the `QueryManager`
 *     to iterate through **every active query** to see if this new archetype is a match.
 *
 * This process, when repeated frequently, leads to severe performance degradation.
 *
 * #### The Solution: Keep Empty Archetypes
 *
 * By treating archetype definitions as immortal, we completely eliminate this churn.
 * When an archetype becomes empty, its large data arrays can be garbage collected, but the lightweight `Archetype` metadata object itself is kept in the manager's map.
 */

const { Chunk } = await import(`${PATH_ECS}/ArchetypeManager/Chunk.js`)
import * as Schema from '../ComponentManager/ComponentSchema.js'

const DEFAULT_CHUNK_CAPACITY = 256
export const MAX_ARCHETYPES = 4096

export class ArchetypeManager {
	constructor() {
		this.archetypeLookup = new Map()
		this.nextArchetype = 0
		this.archetypeMasks = []
		this.archetypeComponentTypeIDs = []
		this.archetypeChunks = []
		this.archetypeEntityMaps = []
		this.archetypeTransitions = []
		this.archetypeLastNonFullChunk = []
	}

	async init(theManager) {
		this.queryManager = theManager.getManager('QueryManager')
		this.componentManager = theManager.getManager('ComponentManager')
		this.systemManager = theManager.getManager('SystemManager')
		this.entityManager = theManager.getManager('EntityManager')
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
					`ArchetypeManager.generateArchetypeMask: Received 'undefined' in componentTypeIDs array. ` +
						`This usually means a component name was not found or was not registered. ` +
						`Provided components: [${definedComponentNames}, undefined]`
				)
			}
			mask |= Schema.componentBitFlags[typeID]
		}
		return mask
	}

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
			throw new Error(`ArchetypeManager: Maximum number of archetypes (${MAX_ARCHETYPES}) reached.`)
		}

		if (!sortedTypeIDs) {
			sortedTypeIDs = this.getComponentTypesFromMask(archetypeMask)
		}

		this.archetypeMasks[id] = archetypeMask
		this.archetypeComponentTypeIDs[id] = new Set(sortedTypeIDs)
		this.archetypeChunks[id] = []
		this.archetypeEntityMaps[id] = new Map()
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

	hasComponentType(archetype, componentTypeID) {
		return this.archetypeComponentTypeIDs[archetype]?.has(componentTypeID)
	}

	/**
	 * Gets the precise location of an entity within its archetype's data structures.
	 * @param {bigint} entityId The ID of the entity to locate.
	 * @returns {{chunk: import('./Chunk.js').Chunk, indexInChunk: number} | undefined} The entity's location or undefined if not found.
	 */
	getEntityLocation(entityId) {
		const archetypeId = this.entityManager.getArchetypeForEntity(entityId)
		if (archetypeId === undefined) return undefined

		return this.archetypeEntityMaps[archetypeId]?.get(entityId)
	}

	_groupEntitiesByArchetype(entities) {
		const entitiesByArchetype = new Map()
		for (const entityId of entities) {
			const archetypeId = this.entityManager.getArchetypeForEntity(entityId)
			if (archetypeId === undefined) continue

			if (!entitiesByArchetype.has(archetypeId)) {
				entitiesByArchetype.set(archetypeId, [])
			}
			entitiesByArchetype.get(archetypeId).push(entityId)
		}
		return entitiesByArchetype
	}

	/**
	 * Efficiently adds a component to all entities matching a query.
	 * This operates by moving entire chunks of entities between archetypes.
	 * @param {import('../../Managers/QueryManager/Query.js').Query} query
	 * @param {number} typeID
	 * @param {number} dataOffset
	 * @param {number} dataLength
	 * @param {import('../SystemManager/CommandBufferReader.js').CommandBufferReader} reader
	 */
	addComponentToQuery(query, typeID, dataOffset, dataLength, reader) {
		for (const sourceArchetypeId of query.matchingArchetypeIds) {
			// This archetype already has the component, so we can skip it.
			if (this.hasComponentType(sourceArchetypeId, typeID)) continue

			const sourceArchetypeMask = this.archetypeMasks[sourceArchetypeId]
			const targetArchetypeMask = sourceArchetypeMask | Schema.componentBitFlags[typeID]
			const targetArchetypeId = this.getArchetypeByMask(targetArchetypeMask)

			// Process all chunks from the source archetype.
			this._moveAllChunksToNewArchetype(sourceArchetypeId, targetArchetypeId, typeID, dataOffset, dataLength, reader)
		}
	}

	/**
	 * Efficiently removes a component from all entities matching a query.
	 * @param {import('../../Managers/QueryManager/Query.js').Query} query
	 * @param {number} componentTypeID
	 */
	removeComponentFromQuery(query, componentTypeID) {
		for (const sourceArchetypeId of query.matchingArchetypeIds) {
			// This archetype doesn't have the component, so we can skip it.
			if (!this.hasComponentType(sourceArchetypeId, componentTypeID)) continue

			const sourceArchetypeMask = this.archetypeMasks[sourceArchetypeId]
			// Calculate target by REMOVING the component's bit flag.
			const targetArchetypeMask = sourceArchetypeMask & ~Schema.componentBitFlags[componentTypeID]
			const targetArchetypeId = this.getArchetypeByMask(targetArchetypeMask)

			// Process all chunks from the source archetype.
			this._moveAllChunksToNewArchetype(sourceArchetypeId, targetArchetypeId, -1, -1, -1, null) // -1 indicates no new component
		}
	}

	setComponentDataOnQuery(query, componentTypeID, dataOffset, dataLength, reader) {
		const currentTick = this.systemManager.currentTick
		const sourceView = new DataView(reader.buffer, dataOffset, dataLength)

		for (const archetypeId of query.matchingArchetypeIds) {
			// This is an in-place update, so skip archetypes that don't have the component.
			if (!this.hasComponentType(archetypeId, componentTypeID)) continue

			const chunks = this.archetypeChunks[archetypeId]
			for (const chunk of chunks) {
				this._fillComponentDataFromBuffer(chunk, componentTypeID, sourceView, currentTick)
			}
		}
	}

	clearAll() {
		for (const archetype of this.archetypeLookup.values()) {
			this.queryManager.unregisterArchetype(archetype)
		}
		this.archetypeLookup.clear()
		this.archetypeMasks.length = 0
		this.archetypeComponentTypeIDs.length = 0
		this.archetypeChunks.length = 0
		this.archetypeEntityMaps.length = 0
		this.archetypeTransitions.length = 0
		this.nextArchetype = 0
		this.archetypeLastNonFullChunk.length = 0
	}

	_setComponentData(chunk, indexInChunk, typeID, componentData) {
		const info = Schema.componentInfo[typeID]
		const compiledDefaults = Schema.compiledDefaults[typeID]
		const propArrays = chunk.componentArrays[typeID]

		for (const propName of info.propertyKeys) {
			const value = componentData?.[propName] ?? compiledDefaults[propName]
			if (propArrays[propName]) {
				propArrays[propName][indexInChunk] = value ?? 0
			}
		}
	}

	/**
	 * "Blit" operation for `setComponentData`.
	 * This method receives pre-gathered source and destination data and performs
	 * the tightest possible copy loop.
	 * @param {Chunk} chunk The destination chunk.
	 * @param {number} typeID The component type ID being written.
	 * @param {number[]} destIndices An array of indices to write to in the destination.
	 * @param {number[]} dataOffsets An array of offsets to the binary data in the command buffer.
	 * @param {number[]} dataLengths An array of lengths of the binary data.
	 * @param {import('../SystemManager/CommandBufferReader.js').CommandBufferReader} reader The reader for the raw command buffer.
	 * @param {number} currentTick The current game tick.
	 * @private
	 */
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

	/**
	 * Fills a component's data for all entities in a chunk from a single binary source.
	 * @param {Chunk} chunk The chunk to modify.
	 * @param {number} typeID The component type ID.
	 * @param {DataView} sourceView The DataView containing the source data.
	 * @param {number} currentTick The current game tick.
	 * @private
	 */
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

	/**
	 * Fills a component's data for a range of entities in a chunk from a single AoS payload.
	 * This is path for batch operations like `addComponentToQuery`.
	 * @param {Chunk} chunk The chunk to modify.
	 * @param {number} typeID The component type ID.
	 * @param {ArrayBuffer} aosPayload The AoS-formatted payload buffer.
	 * @param {number} startIndex The starting index in the chunk.
	 * @param {number} endIndex The ending index (exclusive) in the chunk.
	 * @param {number} currentTick The current game tick.
	 * @private
	 */
	_fillComponentDataFromAoS(chunk, typeID, aosPayload, startIndex, endIndex, currentTick) {
		const info = Schema.componentInfo[typeID]
		if (info.byteSize === 0) return // Nothing to fill for tag components.

		const valuesToFill = this._unpackPayloadOnce(typeID, aosPayload)
		const propArrays = chunk.componentArrays[typeID]

		for (const propKey in valuesToFill) {
			propArrays[propKey]?.fill(valuesToFill[propKey], startIndex, endIndex)
		}
		chunk.lastDirtyTick = currentTick
		chunk.dirtyTicksArrays[typeID].fill(currentTick, startIndex, endIndex)
	}

	/**
	 * Adds a single entity to an archetype and sets its component data from a pre-compiled binary SoA payload.
	 * This is the new, "zero-overhead" creation path that reads from the binary blob and writes to the chunk.
	 * @param {number} archetype The target archetype ID.
	 * @param {bigint} entityId The ID of the new entity.
	 * @param {ArrayBuffer} binarySoAPayload The binary SoA-structured payload data.
	 * @param {number} currentTick The current game tick.
	 * @private
	 */
	addEntityFromBinarySoAPayload(archetype, entityId, binarySoAPayload, currentTick) {
		const chunk = this._findOrCreateChunk(archetype)
		const indexInChunk = chunk.addEntity(entityId)
		this.archetypeEntityMaps[archetype].set(entityId, { chunk, indexInChunk })
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

	_findOrCreateChunk(archetypeId) {
		const chunks = this.archetypeChunks[archetypeId]
		if (!chunks) return null // Archetype might not exist yet
		const lastNonFullChunkIndex = this.archetypeLastNonFullChunk[archetypeId] || 0

		// Start search from the last known non-full chunk
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
		const relevantInfos = {}
		for (const typeID of componentTypeIDs) {
			relevantInfos[typeID] = Schema.componentInfo[typeID]
		}

		const newChunk = new Chunk(archetypeId, componentTypeIDs, relevantInfos, DEFAULT_CHUNK_CAPACITY)
		chunks.push(newChunk)
		this.archetypeLastNonFullChunk[archetypeId] = chunks.length - 1
		return newChunk
	}

	/**
	 * path for query-based structural changes.
	 * It moves all entities from all chunks of a source archetype to a target archetype.
	 * @param {number} sourceArchetypeId
	 * @param {number} targetArchetypeId
	 * @param {number} newComponentTypeId The component being added, or -1 if none. * @param {number} dataOffset The offset to the binary data for the new component.
	 * @param {number} dataLength The length of the binary data.
	 * @param {import('../SystemManager/CommandBufferReader.js').CommandBufferReader} reader The reader for the raw command buffer.
	 * @private
	 */
	_moveAllChunksToNewArchetype(
		sourceArchetypeId,
		targetArchetypeId,
		newComponentTypeId,
		dataOffset,
		dataLength,
		reader
	) {
		const sourceChunks = this.archetypeChunks[sourceArchetypeId]
		if (!sourceChunks || sourceChunks.length === 0) {
			return
		}

		const copyPlan = this._getOrCreateCopyPlan(sourceArchetypeId, targetArchetypeId)
		const currentTick = this.systemManager.currentTick

		let sourceViewForNewComponent = null
		if (newComponentTypeId !== -1) {
			sourceViewForNewComponent = new DataView(reader.buffer, dataOffset, dataLength)
		}

		const sourceEntityMap = this.archetypeEntityMaps[sourceArchetypeId]
		const targetEntityMap = this.archetypeEntityMaps[targetArchetypeId]

		// We must process all chunks before modifying the sourceChunks array.
		//! Heavy
		const chunksToProcess = [...sourceChunks]

		for (const sourceChunk of chunksToProcess) {
			if (sourceChunk.size === 0) continue

			let sourceCursor = 0
			const totalToMove = sourceChunk.size

			while (sourceCursor < totalToMove) {
				const targetChunk = this._findOrCreateChunk(targetArchetypeId)
				targetChunk.lastDirtyTick = currentTick
				const spaceInTarget = targetChunk.capacity - targetChunk.size
				const countToMoveThisBatch = Math.min(totalToMove - sourceCursor, spaceInTarget)

				if (countToMoveThisBatch <= 0) {
					console.error('ArchetypeManager: Could not find a chunk with space to move entities.')
					break // Safeguard
				}

				const startIndexInTarget = targetChunk.size
				const sourceStartIndex = sourceCursor
				const sourceEndIndex = sourceStartIndex + countToMoveThisBatch

				// Copy Entity IDs
				targetChunk.entities.set(sourceChunk.entities.subarray(sourceStartIndex, sourceEndIndex), startIndexInTarget)

				//  Update entity locations
				for (let j = 0; j < countToMoveThisBatch; j++) {
					const entityId = sourceChunk.entities[sourceStartIndex + j]
					const index = Number(entityId & 0xffffffffn)
					this.entityManager.entityArchetype[index] = targetArchetypeId
					targetEntityMap.set(entityId, { chunk: targetChunk, indexInChunk: startIndexInTarget + j })
				}

				//  Copy existing component data
				for (const typeID of copyPlan.toCopy) {
					const sourceArrays = sourceChunk.componentArrays[typeID]
					const targetArrays = targetChunk.componentArrays[typeID]
					for (const propKey in sourceArrays) {
						targetArrays[propKey].set(
							sourceArrays[propKey].subarray(sourceStartIndex, sourceEndIndex),
							startIndexInTarget
						)
					}
					targetChunk.dirtyTicksArrays[typeID].fill(
						currentTick,
						startIndexInTarget,
						startIndexInTarget + countToMoveThisBatch
					)
				}

				// Initialize new component data
				// In a query-based move, there is only ever one new component.
				if (newComponentTypeId !== -1) {
					this._fillComponentDataFromBuffer(targetChunk, newComponentTypeId, sourceViewForNewComponent, currentTick)
				}

				targetChunk.size += countToMoveThisBatch
				sourceCursor += countToMoveThisBatch
			}
		}

		// After moving all entities from all source chunks, clear the source archetype.
		sourceEntityMap.clear()
		sourceChunks.length = 0
	}

	_removeEntity(archetype, entityId) {
		const entityMap = this.archetypeEntityMaps[archetype]
		const location = entityMap.get(entityId)
		if (!location) {
			return
		}

		const { chunk, indexInChunk } = location
		const swappedMappings = chunk.removeEntityAtIndex(indexInChunk)

		entityMap.delete(entityId)

		for (const [swappedEntityId, newIndex] of swappedMappings.entries()) {
			entityMap.set(swappedEntityId, { chunk, indexInChunk: newIndex })
		}

		if (chunk.size === 0) {
			const chunks = this.archetypeChunks[archetype]
			const chunkIndex = chunks.indexOf(chunk)
			if (chunkIndex > -1) {
				chunks.splice(chunkIndex, 1)
				// Adjust last non-full chunk index if needed
				if (this.archetypeLastNonFullChunk[archetype] >= chunkIndex) {
					this.archetypeLastNonFullChunk[archetype]--
				}
			}
		}
	}

	_addIdenticalEntitiesBatch(archetype, entities, payload, currentTick) {
		const count = entities.length
		if (count === 0) return

		const entityMap = this.archetypeEntityMaps[archetype]
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
				entityMap.set(entitiesSlice[i], { chunk, indexInChunk: startIndexInChunk + i })
			}

			// --- OPTIMIZATION ---
			// Unpack the payload ONCE, then use batch fills for each property.
			const componentTypeIDs = this.archetypeComponentTypeIDs[archetype]
			for (const typeID of componentTypeIDs) {
				const info = this.componentManager.componentInfo[typeID]
				if (info.byteSize === 0) continue

				const valuesToFill = this._unpackPayloadOnce(typeID, payload)
				const propArrays = chunk.componentArrays[typeID]

				for (const propKey in valuesToFill) {
					propArrays[propKey]?.fill(valuesToFill[propKey], startIndexInChunk, endIndexInChunk)
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
			toCopy: [],
			toInitialize: [],
		}

		for (const typeID of targetComponents) {
			if (sourceComponents.has(typeID)) {
				plan.toCopy.push(typeID)
			} else {
				plan.toInitialize.push(typeID)
			}
		}

		sourceTransitions.add[targetArchetypeId] = plan
		return plan
	}

	/**
	 * A helper to unpack an AoS payload buffer into a simple key-value object.
	 * This is used to get the values for a batch-fill operation.
	 * @param {number} typeID The component type ID.
	 * @param {ArrayBuffer} sourceBuffer The AoS payload buffer.
	 * @returns {object} An object like `{x: 10, y: 20}`.
	 * @private
	 */
	_unpackPayloadOnce(typeID, sourceBuffer) {
		const info = Schema.componentInfo[typeID]
		if (!info || info.byteSize === 0) return {}

		const values = {}
		let sourceOffset = 0
		for (const propKey of info.propertyKeys) {
			const propInfo = info.properties[propKey]
			const sourceValueArray = new propInfo.arrayConstructor(sourceBuffer, sourceOffset, 1)
			values[propKey] = sourceValueArray[0]
			sourceOffset += propInfo.arrayConstructor.BYTES_PER_ELEMENT
		}
		return values
	}

	_writeComponentDataFromBuffer(chunk, indexInChunk, typeID, sourceView, componentBaseOffset) {
		const info = Schema.componentInfo[typeID]
		const destSoaArrays = chunk.componentArrays[typeID]

		// Iterate through the flattened properties to write data.
		for (const propKey of info.propertyKeys) {
			const propInfo = info.properties[propKey]
			if (!propInfo) continue

			const readOffset = componentBaseOffset + propInfo.offset
			let value
			if (propInfo.arrayConstructor.name.startsWith('Big')) {
				value = sourceView[propInfo.readMethod](readOffset, true)
			} else {
				value = sourceView[propInfo.readMethod](readOffset, true)
			}
			destSoaArrays[propKey][indexInChunk] = value
		}
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
		const targetEntityMap = this.archetypeEntityMaps[targetArchetype]
		let entityCursor = 0

		while (entityCursor < count) {
			const targetChunk = this._findOrCreateChunk(targetArchetype)

			targetChunk.lastDirtyTick = currentTick
			const spaceInChunk = targetChunk.capacity - targetChunk.size
			const entitiesToAddInChunk = Math.min(count - entityCursor, spaceInChunk)
			const startIndexInChunk = targetChunk.size
			const endIndexInChunk = startIndexInChunk + entitiesToAddInChunk

			for (let i = 0; i < entitiesToAddInChunk; i++) {
				const overallIndex = entityCursor + i
				const targetIndex = startIndexInChunk + i
				const entityId = entityIds[overallIndex]
				const { chunk: sourceChunk, indexInChunk: sourceIndex } = sourceLocations[overallIndex]

				// 1. Add entity and update mappings
				targetChunk.entities[targetIndex] = entityId
				const newLocation = { chunk: targetChunk, indexInChunk: targetIndex }
				targetEntityMap.set(entityId, newLocation)
				newLocationsMap.set(entityId, newLocation)

				// 2. Copy component data for shared components
				for (const typeID of copyPlan.toCopy) {
					const sourcePropArrays = sourceChunk.componentArrays[typeID]
					const targetPropArrays = targetChunk.componentArrays[typeID]
					const info = Schema.componentInfo[typeID]
					for (const propKey of info.propertyKeys) {
						if (targetPropArrays?.[propKey] && sourcePropArrays?.[propKey]) {
							const sourceSubarray = sourcePropArrays[propKey].subarray(sourceIndex, sourceIndex + 1)
							targetPropArrays[propKey].set(sourceSubarray, targetIndex)
						}
					}
					targetChunk.dirtyTicksArrays[typeID][targetIndex] = currentTick
				}
			}

			// --- 3. Initialize new components ---
			for (const typeID of copyPlan.toInitialize) {
				const payloadInfo = componentsToAssign.get(typeID)
				if (!payloadInfo) continue

				// Gather indices for this chunk
				for (let i = 0; i < entitiesToAddInChunk; i++) {
					const overallIndex = entityCursor + i
					const destIndex = startIndexInChunk + i
					const sourceOffset = payloadInfo.dataOffsets[overallIndex]
					const sourceLength = payloadInfo.dataLengths[overallIndex]
					const sourceView = new DataView(reader.buffer, sourceOffset, sourceLength)
					this._writeComponentDataFromBuffer(targetChunk, destIndex, typeID, sourceView, 0)
					targetChunk.dirtyTicksArrays[typeID][destIndex] = currentTick
				}
			}
			targetChunk.size += entitiesToAddInChunk
			entityCursor += entitiesToAddInChunk
		}
	}

	_removeEntitiesBatch(archetype, entityIds) {
		const removalsByChunk = new Map()
		const entityMap = this.archetypeEntityMaps[archetype]
		const chunks = this.archetypeChunks[archetype]

		for (const entityId of entityIds) {
			const location = entityMap.get(entityId)
			if (location) {
				const { chunk, indexInChunk } = location
				if (!removalsByChunk.has(chunk)) {
					removalsByChunk.set(chunk, [])
				}
				removalsByChunk.get(chunk).push(indexInChunk)
				entityMap.delete(entityId)
			}
		}

		for (const [chunk, indicesToRemove] of removalsByChunk.entries()) {
			indicesToRemove.sort((a, b) => b - a)
			const swappedMappings = chunk.removeEntitiesAtIndexes(indicesToRemove)

			for (const [swappedEntityId, newIndex] of swappedMappings.entries()) {
				entityMap.set(swappedEntityId, { chunk, indexInChunk: newIndex })
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
}

export const archetypeManager = new ArchetypeManager()
