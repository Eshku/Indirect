/**
 * @fileoverview Manages archetypes, which are unique combinations of components.
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
						`This usually means a component class was not found by name or was not registered. ` +
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
				const { entityIds, componentsToAssignArrays } = moveData
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
							componentsToAssignArrays: [],
						})
					}
					const group = movesByChunk.get(sourceChunk)
					group.entityIds.push(entityIds[i])
					group.sourceLocations.push(sourceLocation)
					group.componentsToAssignArrays.push(componentsToAssignArrays[i])
				}

				// Process one source chunk at a time
				for (const [sourceChunk, chunkMoveData] of movesByChunk.entries()) {
					// 1. Add entities to the target archetype by copying data from the source chunk.
					const newLocationsMap = this._addEntitiesByCopyingBatch(
						targetArchetypeId,
						sourceArchetypeId,
						chunkMoveData.sourceLocations,
						chunkMoveData.entityIds,
						chunkMoveData.componentsToAssignArrays,
						this.systemManager.currentTick
					)

					// 2. Update the central entity-to-archetype mapping.
					// This is safe to do here because the entity IDs are unique.
					for (const entityId of newLocationsMap.keys()) {
						this.entityManager.entityArchetype[entityId] = targetArchetypeId
					}

					// 3. Remove the entities from the source archetype in a single batch.
					this._removeEntitiesBatch(sourceArchetypeId, chunkMoveData.entityIds)
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
	 * @param {number} componentTypeID
	 * @param {object} data
	 */
	addComponentToQuery(query, componentTypeID, data) {
		const moves = new Map()
		const componentsToAssign = new Map([[componentTypeID, data]])

		for (const sourceArchetypeId of query.matchingArchetypeIds) {
			// This archetype already has the component, so we can skip it.
			if (this.hasComponentType(sourceArchetypeId, componentTypeID)) continue

			const sourceArchetypeMask = this.archetypeMasks[sourceArchetypeId]
			const targetArchetypeMask = sourceArchetypeMask | this.componentManager.componentBitFlags[componentTypeID]
			const targetArchetypeId = this.getArchetypeByMask(targetArchetypeMask)

			const sourceChunks = this.archetypeChunks[sourceArchetypeId]
			if (!sourceChunks || sourceChunks.length === 0) continue

			const entityIds = []
			const componentsToAssignArrays = []

			for (const chunk of sourceChunks) {
				for (let i = 0; i < chunk.size; i++) {
					entityIds.push(chunk.entities[i])
					componentsToAssignArrays.push(componentsToAssign)
				}
			}

			if (!moves.has(sourceArchetypeId)) moves.set(sourceArchetypeId, new Map())
			const sourceMoves = moves.get(sourceArchetypeId)
			sourceMoves.set(targetArchetypeId, { entityIds, componentsToAssignArrays })
		}

		if (moves.size > 0) {
			this.moveEntitiesInBatch(moves)
		}
	}

	/**
	 * Efficiently removes a component from all entities matching a query.
	 * @param {import('../QueryManager/Query.js').Query} query
	 * @param {number} componentTypeID
	 */
	removeComponentFromQuery(query, componentTypeID) {
		const moves = new Map()
		// When removing, there is no new data to assign.
		const emptyComponentsToAssign = new Map()

		for (const sourceArchetypeId of query.matchingArchetypeIds) {
			// This archetype doesn't have the component, so we can skip it.
			if (!this.hasComponentType(sourceArchetypeId, componentTypeID)) continue

			const sourceArchetypeMask = this.archetypeMasks[sourceArchetypeId]
			// Calculate target by REMOVING the component's bit flag.
			const targetArchetypeMask = sourceArchetypeMask & ~this.componentManager.componentBitFlags[componentTypeID]
			const targetArchetypeId = this.getArchetypeByMask(targetArchetypeMask)

			const sourceChunks = this.archetypeChunks[sourceArchetypeId]
			if (!sourceChunks || sourceChunks.length === 0) continue

			const entityIds = []
			const componentsToAssignArrays = []

			for (const chunk of sourceChunks) {
				for (let i = 0; i < chunk.size; i++) {
					entityIds.push(chunk.entities[i])
					// Every entity gets an empty map since we are not adding data.
					componentsToAssignArrays.push(emptyComponentsToAssign)
				}
			}

			if (!moves.has(sourceArchetypeId)) moves.set(sourceArchetypeId, new Map())
			const sourceMoves = moves.get(sourceArchetypeId)
			sourceMoves.set(targetArchetypeId, { entityIds, componentsToAssignArrays })
		}

		if (moves.size > 0) {
			this.moveEntitiesInBatch(moves)
		}
	}

	setComponentDataOnQuery(query, componentTypeID, data) {
		const currentTick = this.systemManager.currentTick

		for (const archetypeId of query.matchingArchetypeIds) {
			// This is an in-place update, so skip archetypes that don't have the component.
			if (!this.hasComponentType(archetypeId, componentTypeID)) continue

			this.updateArchetypeMaxTick(archetypeId, currentTick)

			const chunks = this.archetypeChunks[archetypeId]
			for (const chunk of chunks) {
				if (chunk.size === 0) continue

				// This is the most efficient way: set data for the entire chunk at once.
				this._setComponentDataForChunk(chunk, componentTypeID, data, currentTick)
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
		const defaultInstance = this.componentManager.getDefaultInstance(typeID)
		const propArrays = chunk.componentArrays[typeID]

		for (const propName of info.propertyKeys) {
			const value = componentData?.[propName] ?? defaultInstance[propName]
			if (propArrays[propName]) {
				propArrays[propName][indexInChunk] = value ?? 0
			}
		}
	}

	_setComponentDataForChunk(chunk, typeID, componentData, currentTick) {
		const info = this.componentManager.componentInfo[typeID]
		const defaultInstance = this.componentManager.getDefaultInstance(typeID)
		const propArrays = chunk.componentArrays[typeID]

		// Use TypedArray.fill for maximum performance on the whole chunk.
		for (const propName of info.propertyKeys) {
			const value = componentData?.[propName] ?? defaultInstance[propName]
			if (propArrays[propName]) {
				propArrays[propName].fill(value ?? 0, 0, chunk.size)
			}
		}

		// Mark all entities in the chunk as dirty for this component.
		chunk.dirtyTicksArrays[typeID].fill(currentTick, 0, chunk.size)
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

	_addEntity(archetype, entityID, componentsDataMap, currentTick) {
		const chunk = this._findOrCreateChunk(archetype)

		const indexInChunk = chunk.addEntity(entityID)
		this.archetypeEntityMaps[archetype].set(entityID, { chunk, indexInChunk })

		this.updateArchetypeMaxTick(archetype, currentTick)

		const componentTypeIDs = this.archetypeComponentTypeIDs[archetype]
		for (const typeID of componentTypeIDs) {
			this._setComponentData(chunk, indexInChunk, typeID, componentsDataMap.get(typeID))
			chunk.dirtyTicksArrays[typeID][indexInChunk] = currentTick
		}
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

	_addEntitiesBatch(archetype, entities, componentsDataMaps, currentTick) {
		const count = entities.length
		if (count === 0) return

		this.updateArchetypeMaxTick(archetype, currentTick)

		const entityMap = this.archetypeEntityMaps[archetype]
		const componentTypeIDs = this.archetypeComponentTypeIDs[archetype]
		let entityCursor = 0

		while (entityCursor < count) {
			const chunk = this._findOrCreateChunk(archetype)

			const spaceInChunk = chunk.capacity - chunk.size
			const entitiesToAddInChunk = Math.min(count - entityCursor, spaceInChunk)
			const startIndexInChunk = chunk.size

			for (let i = 0; i < entitiesToAddInChunk; i++) {
				const overallIndex = entityCursor + i
				const indexInChunk = startIndexInChunk + i
				const entityId = entities[overallIndex]

				chunk.entities[indexInChunk] = entityId
				entityMap.set(entityId, { chunk, indexInChunk })

				const entityComponentsData = componentsDataMaps[overallIndex]
				for (const typeID of componentTypeIDs) {
					this._setComponentData(chunk, indexInChunk, typeID, entityComponentsData.get(typeID))
					chunk.dirtyTicksArrays[typeID][indexInChunk] = currentTick
				}
			}

			chunk.size += entitiesToAddInChunk
			entityCursor += entitiesToAddInChunk
		}
	}

	_addIdenticalEntitiesBatch(archetype, entities, componentIdMap, currentTick) {
		const count = entities.length
		if (count === 0) return

		this.updateArchetypeMaxTick(archetype, currentTick)

		const entityMap = this.archetypeEntityMaps[archetype]
		const componentTypeIDs = this.archetypeComponentTypeIDs[archetype]
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

			for (const typeID of componentTypeIDs) {
				const info = this.componentManager.componentInfo[typeID]
				const userData = componentIdMap.get(typeID)
				const defaultInstance = this.componentManager.getDefaultInstance(typeID)
				const propArrays = chunk.componentArrays[typeID]

				for (const propName of info.propertyKeys) {
					const valueToFill = userData?.[propName] ?? defaultInstance[propName]
					propArrays[propName]?.fill(valueToFill ?? 0, startIndexInChunk, endIndexInChunk)
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

	_addEntitiesByCopyingBatch(
		targetArchetype,
		sourceArchetype,
		sourceLocations,
		entityIds,
		componentsToAssignArrays,
		currentTick
	) {
		const count = entityIds.length
		if (count === 0) return new Map()

		this.updateArchetypeMaxTick(targetArchetype, currentTick)

		const copyPlan = this._getOrCreateCopyPlan(sourceArchetype, targetArchetype)
		const newLocationsMap = new Map()
		const targetEntityMap = this.archetypeEntityMaps[targetArchetype]
		let entityCursor = 0

		while (entityCursor < count) {
			const targetChunk = this._findOrCreateChunk(targetArchetype)

			const spaceInChunk = targetChunk.capacity - targetChunk.size
			const entitiesToAddInChunk = Math.min(count - entityCursor, spaceInChunk)
			const startIndexInChunk = targetChunk.size

			for (let i = 0; i < entitiesToAddInChunk; i++) {
				const overallIndex = entityCursor + i
				const targetIndex = startIndexInChunk + i
				const entityId = entityIds[overallIndex]
				const { chunk: sourceChunk, indexInChunk: sourceIndex } = sourceLocations[overallIndex]
				const componentsToAssign = componentsToAssignArrays[overallIndex]

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

				// 3. Initialize new components with assigned data or defaults
				for (const typeID of copyPlan.toInitialize) {
					const data = componentsToAssign.get(typeID)
					this._setComponentData(targetChunk, targetIndex, typeID, data) // `data` can be undefined, which is handled
					targetChunk.dirtyTicksArrays[typeID][targetIndex] = currentTick
				}
			}

			targetChunk.size += entitiesToAddInChunk
			entityCursor += entitiesToAddInChunk
		}

		return newLocationsMap
	}

	_setEntitiesComponents(archetype, batchedUpdates, currentTick) {
		if (batchedUpdates.length === 0) return

		this.updateArchetypeMaxTick(archetype, currentTick)

		const entityMap = this.archetypeEntityMaps[archetype]
		const componentTypeIDs = this.archetypeComponentTypeIDs[archetype]

		for (const { entityId, componentsToUpdate } of batchedUpdates) {
			const location = entityMap.get(entityId)
			if (!location) continue

			const { chunk, indexInChunk } = location

			for (const [typeID, cData] of componentsToUpdate.entries()) {
				if (!componentTypeIDs.has(typeID)) continue

				this._setComponentData(chunk, indexInChunk, typeID, cData)
				chunk.dirtyTicksArrays[typeID][indexInChunk] = currentTick
			}
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
