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

const { Chunk } = await import(`${PATH_MANAGERS}/ArchetypeManager/Chunk.js`)
const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)

const DEFAULT_CHUNK_CAPACITY = 256
export const MAX_ARCHETYPES = 4096

export class ArchetypeManager {
	constructor() {
		this.archetypeLookup = new Map()
		this.nextArchetype = 0
		this.archetypeMaxDirtyTicks = new Uint32Array(MAX_ARCHETYPES)
		this.archetypeMasks = []
		this.archetypeComponentTypeIDs = []
		this.archetypeChunks = []
		this.archetypeEntityMaps = []
		this.archetypeTransitions = []
		this.archetypeLastNonFullChunk = [] // OPTIMIZATION
	}

	async init() {
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
					.map(id => this.componentManager.getComponentNameByTypeID(id))
					.join(', ')
				throw new TypeError(
					`ArchetypeManager.generateArchetypeMask: Received 'undefined' in componentTypeIDs array. ` +
						`This usually means a component name was not found or was not registered. ` +
						`Provided components: [${definedComponentNames}, undefined]`
				)
			}
			mask |= this.componentManager.componentBitFlags[typeID]
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
			sortedTypeIDs = this.componentManager.getComponentTypesFromMask(archetypeMask)
		}

		this.archetypeMasks[id] = archetypeMask
		this.archetypeComponentTypeIDs[id] = new Set(sortedTypeIDs)
		this.archetypeChunks[id] = []
		this.archetypeEntityMaps[id] = new Map()
		this.archetypeTransitions[id] = { add: {}, remove: {} }
		this.archetypeLastNonFullChunk[id] = 0 // OPTIMIZATION

		this.archetypeLookup.set(archetypeMask, id)
		this.queryManager.registerArchetype(id)
		return id
	}

	hasComponentType(archetype, componentTypeID) {
		return this.archetypeComponentTypeIDs[archetype]?.has(componentTypeID)
	}

	updateArchetypeMaxTick(archetype, tick) {
		if (tick > this.archetypeMaxDirtyTicks[archetype]) {
			this.archetypeMaxDirtyTicks[archetype] = tick
		}
	}

	moveEntitiesInBatch(moves) {
		for (const [sourceArchetypeId, targets] of moves.entries()) {
			for (const [targetArchetypeId, moveData] of targets.entries()) {
				const { entityIds, componentsToAssign } = moveData
				if (entityIds.length === 0) continue

				// The executor no longer provides source locations, so we fetch them here.
				// This is more robust as the ArchetypeManager is the source of truth for locations.
				const sourceLocations = []
				const sourceEntityMap = this.archetypeEntityMaps[sourceArchetypeId]
				for (const entityId of entityIds) {
					sourceLocations.push(sourceEntityMap.get(entityId))
				}

				// Group moves by their source chunk for cache-friendly operations
				const movesByChunk = new Map()
				for (let i = 0; i < entityIds.length; i++) {
					const sourceLocation = sourceLocations[i]
					if (!sourceLocation) continue

					const sourceChunk = sourceLocation.chunk
					if (!movesByChunk.has(sourceChunk)) {
						movesByChunk.set(sourceChunk, {
							entityIds: [],
							sourceLocations: [],
							componentsToAssign, // Pass the whole map
						})
					}
					const group = movesByChunk.get(sourceChunk)
					group.entityIds.push(entityIds[i])
					group.sourceLocations.push(sourceLocation)
				}

				// Process one source chunk at a time
				for (const [sourceChunk, chunkMoveData] of movesByChunk.entries()) {
					// 1. Add entities to the target archetype by copying data from the source chunk.
					// The CommandBufferExecutor now owns the command buffer, so we get it from the SystemManager.
					this._addEntitiesByCopyingBatch(
						targetArchetypeId,
						sourceArchetypeId,
						chunkMoveData.sourceLocations,
						chunkMoveData.entityIds,
						chunkMoveData.componentsToAssign,
						this.systemManager.currentTick
					)
					// 2. Remove the entities from the source archetype in a single batch.
					this._removeEntitiesBatch(sourceArchetypeId, chunkMoveData.entityIds)

					// 3. Update the entity manager's archetype mapping for the moved entities.
					for (const entityId of chunkMoveData.entityIds) {
						this.entityManager.entityArchetype[entityId] = targetArchetypeId
					}
				}
			}
		}
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
	 * @param {import('../QueryManager/Query.js').Query} query
	 * @param {number} typeID
	 * @param {number} soaIndex
	 */
	addComponentToQuery(query, typeID, soaIndex) {
		for (const sourceArchetypeId of query.matchingArchetypeIds) {
			// This archetype already has the component, so we can skip it.
			if (this.hasComponentType(sourceArchetypeId, typeID)) continue

			const sourceArchetypeMask = this.archetypeMasks[sourceArchetypeId]
			const targetArchetypeMask = sourceArchetypeMask | this.componentManager.componentBitFlags[typeID]
			const targetArchetypeId = this.getArchetypeByMask(targetArchetypeMask)

			// Process all chunks from the source archetype.
			this._moveAllChunksToNewArchetype(sourceArchetypeId, targetArchetypeId, typeID, soaIndex)
		}

		// The move is handled directly, no need for the generic moveEntitiesInBatch.
	}

	/**
	 * Efficiently removes a component from all entities matching a query.
	 * @param {import('../QueryManager/Query.js').Query} query
	 * @param {number} componentTypeID
	 */
	removeComponentFromQuery(query, componentTypeID) {
		for (const sourceArchetypeId of query.matchingArchetypeIds) {
			// This archetype doesn't have the component, so we can skip it.
			if (!this.hasComponentType(sourceArchetypeId, componentTypeID)) continue

			const sourceArchetypeMask = this.archetypeMasks[sourceArchetypeId]
			// Calculate target by REMOVING the component's bit flag.
			const targetArchetypeMask = sourceArchetypeMask & ~this.componentManager.componentBitFlags[componentTypeID]
			const targetArchetypeId = this.getArchetypeByMask(targetArchetypeMask)

			// Process all chunks from the source archetype.
			this._moveAllChunksToNewArchetype(sourceArchetypeId, targetArchetypeId, -1, -1) // -1 indicates no new component
		}

		// The move is handled directly.
	}

	_addMoveToBatch(moves, sourceId, targetId, entityId, componentPayloads) {
		if (!moves.has(sourceId)) moves.set(sourceId, new Map())

		const sourceMoves = moves.get(sourceId)
		let moveData = sourceMoves.get(targetId)

		if (!moveData) {
			moveData = {
				entityIds: [],
				// The new structure: Map<typeID, { soaIndices: number[] }>
				componentsToAssign: new Map(),
			}
			sourceMoves.set(targetId, moveData)
		}

		moveData.entityIds.push(entityId)

		// Merge the payload info for this entity into the main batch.
		for (const [typeID, payloadInfo] of componentPayloads.entries()) {
			if (!moveData.componentsToAssign.has(typeID)) moveData.componentsToAssign.set(typeID, { soaIndices: [] })
			const batchPayloads = moveData.componentsToAssign.get(typeID)
			batchPayloads.soaIndices.push(payloadInfo.soaIndex)
		}
	}

	setComponentDataOnQuery(query, componentTypeID, soaIndex) {
		const currentTick = this.systemManager.currentTick

		for (const archetypeId of query.matchingArchetypeIds) {
			// This is an in-place update, so skip archetypes that don't have the component.
			if (!this.hasComponentType(archetypeId, componentTypeID)) continue

			const chunks = this.archetypeChunks[archetypeId]
			for (const chunk of chunks) {
				if (chunk.size === 0) continue
				// Use the new SoA-based initialization method
				this._initializeComponentFromSoA(chunk, componentTypeID, soaIndex, 0, chunk.size)
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
		const info = this.componentManager.componentInfo[typeID]
		const compiledDefaults = this.componentManager.getCompiledDefaults(typeID)
		const propArrays = chunk.componentArrays[typeID]

		for (const propName of info.propertyKeys) {
			const value = componentData?.[propName] ?? compiledDefaults[propName]
			if (propArrays[propName]) {
				propArrays[propName][indexInChunk] = value ?? 0
			}
		}
	}

	/**
	 * Initializes or overwrites component data for a range of entities in a chunk
	 * using a single data entry from the SoA command buffer.
	 * @param {Chunk} chunk The target chunk.
	 * @param {number} typeID The component type ID.
	 * @param {number} soaIndex The index of the data in the command buffer's SoA arrays.
	 * @param {number} startIndex The starting index in the chunk.
	 * @param {number} count The number of entities to affect.
	 * @private
	 */
	_initializeComponentFromSoA(chunk, typeID, soaIndex, startIndex, count) {
		const sourceSoaArrays = this.systemManager.commandBufferExecutor._currentCommandBuffer.soaData[typeID]
		const destSoaArrays = chunk.componentArrays[typeID]
		const info = this.componentManager.componentInfo[typeID]
		for (const propKey of info.propertyKeys) {
			const valueToFill = sourceSoaArrays[propKey][soaIndex]
			destSoaArrays[propKey].fill(valueToFill, startIndex, startIndex + count)
		}
		chunk.dirtyTicksArrays[typeID].fill(this.systemManager.currentTick, startIndex, startIndex + count)
	}

	/**
	 * The final, hyper-optimized "Blit" operation for `setComponentData`.
	 * This method receives pre-gathered source and destination data and performs
	 * the tightest possible copy loop.
	 * @param {Chunk} chunk The destination chunk.
	 * @param {number} typeID The component type ID being written.
	 * @param {object} destSoaArrays The destination SoA property arrays from the chunk.
	 * @param {object} sourceSoaArrays The source SoA property arrays from the command buffer.
	 * @param {number[]} destIndices An array of indices to write to in the destination.
	 * @param {number[]} sourceIndices An array of indices to read from in the source.
	 * @private
	 */
	_blitComponentDataFromSoA(chunk, typeID, destSoaArrays, sourceSoaArrays, destIndices, sourceIndices) {
		const info = this.componentManager.componentInfo[typeID]
		const currentTick = this.systemManager.currentTick
		const batchSize = destIndices.length

		// This is now the tightest possible loop. The JIT can heavily optimize this.
		for (const propKey of info.propertyKeys) {
			const dest = destSoaArrays[propKey]
			const source = sourceSoaArrays[propKey]
			for (let i = 0; i < batchSize; i++) {
				dest[destIndices[i]] = source[sourceIndices[i]]
			}
		}
		for (let i = 0; i < batchSize; i++) {
			chunk.dirtyTicksArrays[typeID][destIndices[i]] = currentTick
		}
	}

	/**
	 * Adds a single entity to an archetype and sets its component data from the SoA command buffer.
	 * This is the execution path for the new SoA-based `createEntity` command.
	 * @param {number} archetype The target archetype ID.
	 * @param {number} entityID The ID of the new entity.
	 * @param {Map<number, {soaIndex: number}>} componentsToAssign - Map of componentTypeID to its SoA index.
	 * @param {number} currentTick The current game tick.
	 * @private
	 */
	_addEntityFromSoA(archetype, entityID, componentsToAssign, currentTick) {
		const chunk = this._findOrCreateChunk(archetype)
		const indexInChunk = chunk.addEntity(entityID)
		this.archetypeEntityMaps[archetype].set(entityID, { chunk, indexInChunk })
		this.updateArchetypeMaxTick(archetype, currentTick)

		const sourceSoaBuffers = this.systemManager.commandBufferExecutor._currentCommandBuffer.soaData

		for (const [typeID, { soaIndex }] of componentsToAssign.entries()) {
			const sourceSoaArrays = sourceSoaBuffers[typeID]
			const destSoaArrays = chunk.componentArrays[typeID]
			if (sourceSoaArrays && destSoaArrays) {
				// This is a "Blit" operation for a single entity.
				this._blitComponentDataFromSoA(chunk, typeID, destSoaArrays, sourceSoaArrays, [indexInChunk], [soaIndex])
			}
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
		const newChunk = new Chunk(archetypeId, this, DEFAULT_CHUNK_CAPACITY)
		chunks.push(newChunk)
		this.archetypeLastNonFullChunk[archetypeId] = chunks.length - 1
		return newChunk
	}
	/**
	 * Adds a single entity to an archetype and sets its component data.
	 * This method is exclusively for the immediate-mode API path (e.g., ECS.createEntity).
	 * @param {number} archetype The target archetype ID.
	 * @param {number} entityID The ID of the new entity.
	 * @param {Map<number, object>} componentIdMap - The component data.
	 * @param {number} currentTick The current game tick.
	 * @private
	 */
	_addEntity(archetype, entityID, componentIdMap, currentTick) {
		const chunk = this._findOrCreateChunk(archetype)

		const indexInChunk = chunk.addEntity(entityID)
		this.archetypeEntityMaps[archetype].set(entityID, { chunk, indexInChunk })

		this.updateArchetypeMaxTick(archetype, currentTick)
		const componentTypeIDs = this.archetypeComponentTypeIDs[archetype]
		for (const typeID of componentTypeIDs) {
			this._setComponentData(chunk, indexInChunk, typeID, componentIdMap.get(typeID))
			chunk.dirtyTicksArrays[typeID][indexInChunk] = currentTick
		}
	}

	/**
	 * The new, hyper-optimized path for query-based structural changes.
	 * It moves all entities from all chunks of a source archetype to a target archetype.
	 * @param {number} sourceArchetypeId
	 * @param {number} targetArchetypeId
	 * @param {number} newComponentTypeId The component being added, or -1 if none.
	 * @param {number} newComponentSoaIndex The SoA index for the new component's data, or -1.
	 * @private
	 */
	_moveAllChunksToNewArchetype(sourceArchetypeId, targetArchetypeId, newComponentTypeId, newComponentSoaIndex) {
		const sourceChunks = this.archetypeChunks[sourceArchetypeId]
		if (!sourceChunks || sourceChunks.length === 0) {
			return
		}

		const copyPlan = this._getOrCreateCopyPlan(sourceArchetypeId, targetArchetypeId)
		const currentTick = this.systemManager.currentTick
		this.updateArchetypeMaxTick(targetArchetypeId, currentTick)

		const sourceEntityMap = this.archetypeEntityMaps[sourceArchetypeId]
		const targetEntityMap = this.archetypeEntityMaps[targetArchetypeId]

		// We must process all chunks before modifying the sourceChunks array.
		const chunksToProcess = [...sourceChunks]

		for (const sourceChunk of chunksToProcess) {
			if (sourceChunk.size === 0) continue

			let sourceCursor = 0
			const totalToMove = sourceChunk.size

			while (sourceCursor < totalToMove) {
				const targetChunk = this._findOrCreateChunk(targetArchetypeId)
				const spaceInTarget = targetChunk.capacity - targetChunk.size
				const countToMoveThisBatch = Math.min(totalToMove - sourceCursor, spaceInTarget)

				if (countToMoveThisBatch <= 0) {
					console.error('ArchetypeManager: Could not find a chunk with space to move entities.')
					break // Safeguard
				}

				const startIndexInTarget = targetChunk.size
				const sourceStartIndex = sourceCursor
				const sourceEndIndex = sourceStartIndex + countToMoveThisBatch

				// 1. Copy Entity IDs
				targetChunk.entities.set(sourceChunk.entities.subarray(sourceStartIndex, sourceEndIndex), startIndexInTarget)

				// 2. Update entity locations
				for (let j = 0; j < countToMoveThisBatch; j++) {
					const entityId = sourceChunk.entities[sourceStartIndex + j]
					this.entityManager.entityArchetype[entityId] = targetArchetypeId
					targetEntityMap.set(entityId, { chunk: targetChunk, indexInChunk: startIndexInTarget + j })
				}

				// 3. Copy existing component data
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

				// 4. Initialize new component data
				// In a query-based move, there is only ever one new component.
				if (newComponentTypeId !== -1) {
					this._initializeComponentFromSoA(
						targetChunk,
						newComponentTypeId,
						newComponentSoaIndex,
						startIndexInTarget,
						countToMoveThisBatch
					)
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

		this.updateArchetypeMaxTick(archetype, currentTick)

		const entityMap = this.archetypeEntityMaps[archetype]
		let entityCursor = 0

		while (entityCursor < count) {
			const chunk = this._findOrCreateChunk(archetype)

			const spaceInChunk = chunk.capacity - chunk.size
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
		const info = this.componentManager.componentInfo[typeID]
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

	_addEntitiesByCopyingBatch(
		targetArchetype,
		sourceArchetype,
		sourceLocations,
		entityIds,
		componentsToAssign,
		currentTick
	) {
		const count = entityIds.length
		if (count === 0) return

		this.updateArchetypeMaxTick(targetArchetype, currentTick)

		const copyPlan = this._getOrCreateCopyPlan(sourceArchetype, targetArchetype)
		const sourceSoaBuffers = this.systemManager.commandBufferExecutor._currentCommandBuffer.soaData
		const newLocationsMap = new Map()
		const targetEntityMap = this.archetypeEntityMaps[targetArchetype]
		let entityCursor = 0

		while (entityCursor < count) {
			const targetChunk = this._findOrCreateChunk(targetArchetype)

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
					const info = this.componentManager.componentInfo[typeID]
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
				const sourceSoaArrays = sourceSoaBuffers[typeID]
				const destSoaArrays = targetChunk.componentArrays[typeID]
				const info = this.componentManager.componentInfo[typeID]
				const destIndices = []
				const sourceIndices = []

				// Gather indices for this chunk
				for (let i = 0; i < entitiesToAddInChunk; i++) {
					destIndices.push(startIndexInChunk + i)
					sourceIndices.push(payloadInfo.soaIndices[entityCursor + i])
				}

				// Blit the data for the new components
				this._blitComponentDataFromSoA(targetChunk, typeID, destSoaArrays, sourceSoaArrays, destIndices, sourceIndices)
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
