/**
 * @fileoverview Executes commands from the CommandBuffer in an optimized, batched manner.
 * This class contains the core logic for processing deferred structural changes.
 */

/**
 * A reusable object for tracking entity modifications within the CommandBuffer flush.
 * @private
 */
class Modification {
	constructor() {
		this.additions = new Map()
		this.removals = new Set()
	}
	reset() {
		this.additions.clear()
		this.removals.clear()
	}
}

/**
 * Processes the command buffer, applying all queued structural changes to the world state.
 * This is an internal class used by the CommandBuffer.
 */
export class CommandBufferExecutor {
	/**
	 * @param {import('./CommandBuffer.js').CommandBuffer} commandBuffer
	 */
	constructor(commandBuffer) {
		this.commandBuffer = commandBuffer
		this.entityManager = commandBuffer.entityManager
		this.prefabManager = commandBuffer.prefabManager
		this.componentManager = commandBuffer.componentManager
		this.archetypeManager = commandBuffer.archetypeManager
		this.systemManager = commandBuffer.systemManager

		//  Reusable state for flush() to minimize GC pressure
		this._deletions = new Set()
		this._modifications = new Map()
		this._creations = []
		this._batchInstantiations = []
		this._batchModifications = [] // For add/removeComponentToQuery, etc.
		this._identicalCreations = [] // For createEntities (homogeneous)
		this._archetypeCreations = [] // For createEntityInArchetype
		this._variedCreations = [] // For createEntitiesWithData (heterogeneous)
		this._batchDestructions = [] // For destroyEntitiesInQuery
		this._moves = new Map()
		this._inPlaceDataUpdates = new Map()

		this._modificationPool = []
		this._modificationPoolIndex = 0
	}

	/**
	 * Executes all queued commands.
	 * The flush process is carefully ordered for correctness and performance:
	 * 1. **Consolidate**: A single pass over all commands determines the final state for each entity.
	 * 2. **Destroy**: Entities are destroyed first.
	 * 3. **Modify**: Component additions, removals, and data updates are processed.
	 * 4. **Create**: New entities are created last.
	 */
	execute() {
		//  1. Consolidation Phase (Single Pass)
		this._consolidateCommands()

		// Step 2b: Per-Entity Deletions.
		if (this._deletions.size > 0) {
			this.entityManager.destroyEntitiesInBatch(this._deletions)
		}

		// Step 2c: Batch Modifications (from add/removeComponentToQuery).
		if (this._batchModifications.length > 0) {
			this._flushBatchModifications()
		}

		// Step 2d: Per-Entity Modifications.
		if (this._modifications.size > 0) {
			this._flushModifications()
		}

		// Step 2e: Creations (all types, batched internally).
		this._flushAllCreations()
	}

	/**
	 * Processes the raw command list into consolidated sets of deletions, modifications, and creations.
	 * @private
	 */
	_consolidateCommands() {
		// Reset state from the previous flush.
		this._deletions.clear()
		this._modifications.clear()
		this._creations.length = 0
		this._batchInstantiations.length = 0
		this._identicalCreations.length = 0
		this._variedCreations.length = 0
		this._archetypeCreations.length = 0
		this._batchModifications.length = 0
		this._batchDestructions.length = 0
		this._resetModPool()

		for (const command of this.commandBuffer.commands) {
			switch (command.type) {
				case 'createEntity':
				case 'instantiate':
					this._creations.push(command)
					break
				case 'addComponentToQuery':
				case 'removeComponentFromQuery':
				case 'setComponentDataOnQuery':
					this._batchModifications.push(command)
					break
				case 'instantiateBatch':
					this._batchInstantiations.push(command)
					break
				case 'createEntities':
					this._identicalCreations.push(command)
					break
				case 'createEntityInArchetype':
					this._archetypeCreations.push(command)
					break
				case 'createEntitiesWithData':
					this._variedCreations.push(command)
					break
				case 'destroyEntitiesInQuery':
					this._batchDestructions.push(command)

					// We process batch destructions during consolidation. This ensures that any subsequent
					// commands in the buffer for these entities (e.g., addComponent) are correctly ignored.

					for (const chunk of command.query.iter()) {
						for (let i = 0; i < chunk.size; i++) {
							const entityId = chunk.entities[i]
							this._deletions.add(entityId)
						}
					}
					// Note: We don't need to clear _modifications here, as the check below handles it.
					break
				case 'destroyEntity':
					this._deletions.add(command.entityId)
					this._modifications.delete(command.entityId) // A destruction overrides any pending modifications.
					break
				case 'addComponent':
				case 'setComponentData': {
					// If the entity is already marked for deletion in this same command buffer flush,
					// ignore any further modifications or additions.
					if (this._deletions.has(command.entityId)) {
						continue
					}

					if (!this._modifications.has(command.entityId)) {
						this._modifications.set(command.entityId, this._getModObject())
					}
					const mod = this._modifications.get(command.entityId)
					mod.additions.set(command.componentTypeID, command.data)
					mod.removals.delete(command.componentTypeID) // An add/set overrides a remove.
					break
				}
				case 'removeComponent': {
					// If the entity is already marked for deletion, ignore this command.
					if (this._deletions.has(command.entityId)) {
						continue
					}

					if (!this._modifications.has(command.entityId)) {
						this._modifications.set(command.entityId, this._getModObject())
					}
					const mod = this._modifications.get(command.entityId)
					mod.removals.add(command.componentTypeID)
					mod.additions.delete(command.componentTypeID) // A remove overrides a pending add/set.
					break
				}
			}
		}

		// Final cleanup pass for modifications on entities that were batch-deleted.
		// This is necessary because a `destroyEntitiesInQuery` could be followed by
		// an `addComponent` for one of those entities in the same buffer.
		for (const deletedId of this._deletions) {
			this._modifications.delete(deletedId)
		}
	}

	/**
	 * A private helper that processes all entity modifications.
	 * @private
	 */
	_flushModifications() {
		const moves = this._moves
		const inPlaceDataUpdates = this._inPlaceDataUpdates
		moves.clear()
		inPlaceDataUpdates.clear()

		const componentBitFlags = this.componentManager.componentBitFlags

		for (const [entityId, mod] of this._modifications.entries()) {
			const sourceArchetypeId = this.entityManager.entityArchetype[entityId]
			if (sourceArchetypeId === undefined) continue
			
			const sourceEntityMap = this.archetypeManager.archetypeEntityMaps[sourceArchetypeId]
			const location = sourceEntityMap.get(entityId)
			if (!location) continue

			let addMask = 0n
			for (const typeId of mod.additions.keys()) {
				if (!this.archetypeManager.hasComponentType(sourceArchetypeId, typeId)) {
					addMask |= componentBitFlags[typeId]
				}
			}

			let removeMask = 0n
			for (const typeId of mod.removals) {
				removeMask |= componentBitFlags[typeId]
			}

			if (addMask === 0n && removeMask === 0n) {
				if (!inPlaceDataUpdates.has(sourceArchetypeId)) {
					inPlaceDataUpdates.set(sourceArchetypeId, [])
				}
				inPlaceDataUpdates.get(sourceArchetypeId).push({ entityId, componentsToUpdate: mod.additions })
			} else {
				const targetArchetypeMask = (this.archetypeManager.archetypeMasks[sourceArchetypeId] | addMask) & ~removeMask
				const targetArchetypeId = this.archetypeManager.getArchetypeByMask(targetArchetypeMask)

				if (!moves.has(sourceArchetypeId)) moves.set(sourceArchetypeId, new Map())
				const sourceMoves = moves.get(sourceArchetypeId)
				if (!sourceMoves.has(targetArchetypeId)) {
					sourceMoves.set(targetArchetypeId, {
						entityIds: [],
						sourceLocations: [],
						componentsToAssignArrays: [],
					})
				}
				const targetMoveData = sourceMoves.get(targetArchetypeId)
				targetMoveData.entityIds.push(entityId)
				targetMoveData.sourceLocations.push(location)
				targetMoveData.componentsToAssignArrays.push(mod.additions)
			}
		}

		for (const [archetypeId, updates] of inPlaceDataUpdates.entries()) {
			this.archetypeManager._setEntitiesComponents(archetypeId, updates, this.systemManager.currentTick)
		}

		if (moves.size > 0) {
			this.archetypeManager.moveEntitiesInBatch(moves)
		}
	}

	/**
	 * A private helper that processes all batch modification commands.
	 * @private
	 */
	_flushBatchModifications() {
		const moves = this._moves
		moves.clear()

		for (const command of this._batchModifications) {
			switch (command.type) {
				case 'addComponentToQuery':
					this._processQueryMove(command, moves, true)
					break
				case 'removeComponentFromQuery':
					this._processQueryMove(command, moves, false)
					break
				case 'setComponentDataOnQuery':
					this._processSetComponentDataOnQuery(command)
					break
			}
		}

		if (moves.size > 0) {
			this.archetypeManager.moveEntitiesInBatch(moves)
		}
	}

	_processQueryMove(command, moves, isAdd) {
		const { query, componentTypeID } = command
		const componentsToAssign = isAdd ? new Map([[componentTypeID, command.data]]) : new Map()
		const transitionCacheKey = isAdd ? 'add' : 'remove'
		const componentBitFlag = this.componentManager.componentBitFlags[componentTypeID]

		for (const chunk of query.iter()) {			
			const sourceArchetypeId = chunk.archetype
			const transitions = this.archetypeManager.archetypeTransitions[sourceArchetypeId]
			let targetArchetypeId = transitions[transitionCacheKey][componentTypeID]

			if (targetArchetypeId === undefined) {
				const targetArchetypeMask = isAdd
					? this.archetypeManager.archetypeMasks[sourceArchetypeId] | componentBitFlag
					: this.archetypeManager.archetypeMasks[sourceArchetypeId] & ~componentBitFlag
				targetArchetypeId = this.archetypeManager.getArchetypeByMask(targetArchetypeMask)
				transitions[transitionCacheKey][componentTypeID] = targetArchetypeId
			}

			if (!moves.has(sourceArchetypeId)) moves.set(sourceArchetypeId, new Map())
			const sourceMoves = moves.get(sourceArchetypeId)

			let targetMoveData = sourceMoves.get(targetArchetypeId)
			if (!targetMoveData) {
				targetMoveData = { entityIds: [], sourceLocations: [], componentsToAssignArrays: [] }
				sourceMoves.set(targetArchetypeId, targetMoveData)
			}

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				const entityId = chunk.entities[indexInChunk]
				if (this._deletions.has(entityId) || this._modifications.has(entityId)) continue
				targetMoveData.entityIds.push(entityId)
				targetMoveData.sourceLocations.push({ chunk, indexInChunk })
				targetMoveData.componentsToAssignArrays.push(componentsToAssign)
			}
		}
	}

	_processSetComponentDataOnQuery(command) {
		const { query, componentTypeID, data } = command
		for (const chunk of query.iter()) {
			const archetypeId = chunk.archetype
			const entitiesToUpdate = [] // Entities in this chunk that can be updated directly.
			let hasConflictingMod = false

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				const entityId = chunk.entities[indexInChunk]
				if (this._deletions.has(entityId) || this._modifications.has(entityId)) {
					hasConflictingMod = true
				} else {
					entitiesToUpdate.push(entityId)
				}
			}

			if (!hasConflictingMod) {
				// Fast path: No conflicts, update the entire chunk at once.
				this.archetypeManager._setChunkComponents(archetypeId, chunk, componentTypeID, data, this.systemManager.currentTick)
			} else if (entitiesToUpdate.length > 0) {
				// Slow path: Some entities in this chunk have other modifications.
				// We must update the remaining entities one by one.
				const componentsToUpdate = new Map([[componentTypeID, data]])
				const batchedUpdates = entitiesToUpdate.map(entityId => ({ entityId, componentsToUpdate }))
				this.archetypeManager._setEntitiesComponents(archetypeId, batchedUpdates, this.systemManager.currentTick)
			}
		}
	}

	/**
	 * A single entry point to flush all types of creation commands.
	 * @private
	 */
	_flushAllCreations() {
		// Per-entity and simple prefab creations
		if (this._creations.length > 0) {
			this._flushStandardCreations()
		}
		// Homogeneous batch creations (from createEntities)
		if (this._identicalCreations.length > 0) {
			this._flushIdenticalCreations()
		}
		// Creations with a known archetype
		if (this._archetypeCreations.length > 0) {
			this._flushArchetypeCreations()
		}
		// Batch prefab instantiations
		if (this._batchInstantiations.length > 0) {
			this._flushBatchInstantiations()
		}
		// Heterogeneous batch creations (from createEntitiesWithData)
		if (this._variedCreations.length > 0) {
			this._flushVariedCreations()
		}
	}

	/**
	 * A private helper that processes per-entity creations and simple prefab instantiations.
	 * @private
	 */
	_flushStandardCreations() {
		const { batched, dataDriven } = this._groupCreationCommands(this._creations)

		if (batched.size > 0) {
			for (const [archetypeId, componentIdMaps] of batched.entries()) {
				this.entityManager.createEntitiesInArchetype(archetypeId, componentIdMaps)
			}
		}
		if (dataDriven.size > 0) {
			for (const [prefabName, overridesArray] of dataDriven.entries()) {
				this._executeInstantiateWithData(prefabName, overridesArray)
			}
		}
	}

	/**
	 * A private helper that processes all batch creation commands from `createEntities`.
	 * These are "identical" because each command creates N entities with the same component data.
	 * @private
	 */
	_flushIdenticalCreations() {
		for (const command of this._identicalCreations) {
			const { componentIdMap, count } = command
			if (count <= 0) continue

			const mask = this.archetypeManager.generateArchetypeMask(componentIdMap.keys())
			const archetypeId = this.archetypeManager.getArchetypeByMask(mask)
			this.entityManager.createIdenticalEntitiesInArchetype(archetypeId, componentIdMap, count)
		}
	}

	/**
	 * A private helper that processes all `createEntityInArchetype` commands.
	 * @private
	 */
	_flushArchetypeCreations() {
		const batched = new Map()
		for (const command of this._archetypeCreations) {
			const { archetypeId, componentIdMap } = command
			if (!batched.has(archetypeId)) {
				batched.set(archetypeId, [])
			}
			batched.get(archetypeId).push(componentIdMap)
		}

		if (batched.size > 0) {
			for (const [archetypeId, componentIdMaps] of batched.entries()) {
				this.entityManager.createEntitiesInArchetype(archetypeId, componentIdMaps)
			}
		}
	}

	/**
	 * A private helper that processes all batch prefab instantiations.
	 * @private
	 */
	_flushBatchInstantiations() {
		for (const command of this._batchInstantiations) {
			this._executeInstantiateBatch(command.prefabName, command.count, { overrides: command.overrides })
		}
	}

	/**
	 * A private helper that processes all `createEntitiesWithData` commands.
	 * These are "varied" because each entity in the batch can have different data.
	 * @private
	 */
	_flushVariedCreations() {
		for (const command of this._variedCreations) {
			this._executeCreateEntitiesWithData(command.creationData)
		}
	}

	/**
	 * The internal, immediate-mode implementation for batch-instantiating a data-driven prefab.
	 * @returns {number[]} Array of created root entity IDs.
	 * @internal
	 */
	_executeInstantiateBatch(prefabId, count, { overrides = {} } = {}) {
		// This is now a simple bridge. It creates an array of identical override objects and passes them to the powerful `_executeInstantiateWithData` method.
		const overridesArray = new Array(count).fill(overrides)
		return this._executeInstantiateWithData(prefabId, overridesArray)
	}

	/**
	 * The core logic for all data-driven prefab creation.
	 * @param {string} prefabId - The ID of the data-driven prefab.
	 * @param {object[]} overridesArray - An array of override objects, one for each root entity to create.
	 * @returns {number[]} An array of the created root entity IDs.
	 * @private
	 */
	_executeInstantiateWithData(prefabId, overridesArray) {
		const prefabData = this.prefabManager.getPrefabData(prefabId)
		if (!prefabData) {
			console.error(
				`CommandBufferExecutor: Could not instantiate data-driven prefab '${prefabId}'. Not found or preloaded.`
			)
			return []
		}

		const count = overridesArray.length

		const _recursiveBatchCreator = (nodeData, parentIds, rootIds, levelOverrides, currentPrefabId) => {
			const rawComponentDataArray = this._prepareComponentDataForBatch(
				nodeData,
				count,
				parentIds,
				rootIds,
				levelOverrides
			)
			const creationsByArchetype = this._groupComponentMapsByArchetype(rawComponentDataArray)
			const newEntityIds = this._processAndCreateEntitiesByArchetype(creationsByArchetype, count)

			if (nodeData.children && nodeData.children.length > 0) {
				for (const childData of nodeData.children) {
					// Children are not prefabs themselves, so they don't pass a prefabId
					_recursiveBatchCreator(childData, newEntityIds, rootIds || newEntityIds, null, null)
				}
			}
			return newEntityIds
		}

		const rootNodeData = { ...prefabData, components: { ...prefabData.components, PrefabId: { id: prefabId } } }
		return _recursiveBatchCreator(rootNodeData, null, null, overridesArray, prefabId)
	}

	/**
	 * The internal, immediate-mode implementation for creating entities with heterogeneous data.
	 * @param {Array<object>} creationData
	 */
	_executeCreateEntitiesWithData(creationData) {
		if (!creationData || creationData.length === 0) {
			return []
		}

		const creationsByArchetype = new Map() // Map<archetypeId, Array<{originalIndex: number, componentIdMap: Map}>>

		for (let i = 0; i < creationData.length; i++) {
			const componentsInput = creationData[i]
			// OPTIMIZATION: Use the command buffer's map pool to avoid allocations.
			const componentIdMap = this._convertComponentDataToRawPooledIdMap(componentsInput)
			const archetypeMask = this.archetypeManager.generateArchetypeMask(componentIdMap.keys())
			const archetypeId = this.archetypeManager.getArchetypeByMask(archetypeMask)

			if (!creationsByArchetype.has(archetypeId)) creationsByArchetype.set(archetypeId, [])
			creationsByArchetype.get(archetypeId).push({ originalIndex: i, componentIdMap })
		}

		return this._processAndCreateEntitiesByArchetype(creationsByArchetype, creationData.length)
	}
	/**
	 * A private helper to group creation commands during the consolidation phase.
	 * @private
	 */
	_groupCreationCommands(creations) {
		const batched = new Map() // creationsByArchetype
		const dataDriven = new Map() // dataDrivenInstantiations

		for (const command of creations) {
			if (command.type === 'createEntity') {
				const map = command.componentIdMap
				const mask = this.archetypeManager.generateArchetypeMask(map.keys())
				const archetypeId = this.archetypeManager.getArchetypeByMask(mask)
				if (!batched.has(archetypeId)) {
					batched.set(archetypeId, [])
				}
				batched.get(archetypeId).push(map)
			} else if (command.type === 'instantiate') {
				const prefabName = command.prefabName
				const prefabData = this.prefabManager.getPrefabData(prefabName)
				if (prefabData) {
					if (!dataDriven.has(prefabName)) dataDriven.set(prefabName, [])
					dataDriven.get(prefabName).push(command.overrides)
				}
			}
		}
		return { batched, dataDriven }
	}

	/**
	 * A private helper that takes a map of creations grouped by archetype and executes them.
	 * @returns {number[]} An array of the created entity IDs, in their original requested order.
	 * @private
	 */
	_processAndCreateEntitiesByArchetype(creationsByArchetype, totalCreations) {
		const allNewIds = new Array(totalCreations)

		for (const [archetypeId, group] of creationsByArchetype.entries()) {
			// --- Archetype-level Batch Processing ---
			// This is the core optimization. Instead of processing components entity-by-entity,
			// we process them component-by-component for all entities within the same archetype group.
			const archetype = this.archetypeManager.getArchetypeById(archetypeId)
			for (const typeID of archetype.componentTypeIDs) {
				const specializedProcessor = this.componentManager.componentProcessors[typeID]
				if (specializedProcessor) {
					const componentName = this.componentManager.getComponentNameByTypeID(typeID)
					for (const item of group) {
						const componentIdMap = item.componentIdMap
						if (componentIdMap.has(typeID)) {
							const rawData = componentIdMap.get(typeID)
							const processedData = specializedProcessor(rawData, componentName)
							componentIdMap.set(typeID, processedData)
						}
					}
				}
			}
			// --- End Processing ---

			const componentIdMapsForBatch = group.map(item => item.componentIdMap)
			const newIdsForBatch = this.entityManager.createEntitiesInArchetype(archetypeId, componentIdMapsForBatch)
			for (let i = 0; i < newIdsForBatch.length; i++) {
				const originalIndex = group[i].originalIndex
				allNewIds[originalIndex] = newIdsForBatch[i]
			}
		}
		return allNewIds
	}

	/**
	 * A private helper to group an array of componentIdMaps by their resulting archetype.
	 * @private
	 */
	_groupComponentMapsByArchetype(componentIdMaps) {
		const creationsByArchetype = new Map()
		for (let i = 0; i < componentIdMaps.length; i++) {
			const componentIdMap = componentIdMaps[i]
			if (!componentIdMap) continue

			// OPTIMIZATION: Generate the archetype mask directly from the component keys
			// without creating an intermediate array and sorting it. This is much faster.
			const archetypeMask = this.archetypeManager.generateArchetypeMask(componentIdMap.keys())
			const archetypeId = this.archetypeManager.getArchetypeByMask(archetypeMask)

			if (!creationsByArchetype.has(archetypeId)) {
				creationsByArchetype.set(archetypeId, [])
			}
			creationsByArchetype.get(archetypeId).push({ originalIndex: i, componentIdMap })
		}
		return creationsByArchetype
	}

	/**
	 * A private helper to prepare an array of component data maps for batch creation.
	 * @private
	 */
	_prepareComponentDataForBatch(nodeData, count, parentIds, rootIds, levelOverrides) {
		const componentMaps = []
		const parentComponentTypeId = this.componentManager.getComponentTypeID(
			this.componentManager.getComponentClassByName('Parent')
		)
		const ownerComponentTypeId = this.componentManager.getComponentTypeID(
			this.componentManager.getComponentClassByName('Owner')
		)

		for (let i = 0; i < count; i++) {
			// OPTIMIZATION: Use the command buffer's map pool to avoid GC pressure.
			const map = this.commandBuffer.getMap()
			// Merge prefab data with instance-specific overrides to get the final "cold" data.
			const coldData = { ...nodeData.components, ...(levelOverrides?.[i] || {}) }

			for (const componentName in coldData) {
				if (Object.prototype.hasOwnProperty.call(coldData, componentName)) {
					const typeID = this.componentManager.getComponentTypeIDByName(componentName)
					if (typeID !== undefined) {
						map.set(typeID, coldData[componentName])
					}
				}
			}

			if (parentIds) map.set(parentComponentTypeId, { entityId: parentIds[i] })
			if (rootIds) map.set(ownerComponentTypeId, { entityId: rootIds[i] })
			componentMaps.push(map)
		}
		return componentMaps
	}

	/**
	 * A private helper to convert a string-keyed component data object to a typeID-keyed map,
	 * using the command buffer's map pool to avoid allocations.
	 * @param {object} componentsInput - An object like `{ Position: { x: 10 }, Velocity: { y: 5 } }`.
	 * @returns {Map<number, object>} A pooled map where keys are componentTypeIDs.
	 * @private
	 */
	_convertComponentDataToRawPooledIdMap(componentsInput) {
		const componentIdMap = this.commandBuffer.getMap()
		if (!componentsInput) return componentIdMap

		for (const componentName in componentsInput) {
			if (Object.prototype.hasOwnProperty.call(componentsInput, componentName)) {
				const typeID = this.componentManager.getComponentTypeIDByName(componentName)
				if (typeID !== undefined) {
					componentIdMap.set(typeID, componentsInput[componentName])
				}
			}
		}
		return componentIdMap
	}

	/**
	 * Gets a reusable modification tracking object from a pool.
	 * @returns {Modification}
	 * @private
	 */
	_getModObject() {
		let mod
		if (this._modificationPoolIndex < this._modificationPool.length) {
			mod = this._modificationPool[this._modificationPoolIndex]
		} else {
			mod = new Modification()
			this._modificationPool.push(mod)
		}
		this._modificationPoolIndex++
		mod.reset()
		return mod
	}

	_resetModPool() {
		this._modificationPoolIndex = 0
	}
}