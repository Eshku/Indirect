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

		//  2. Execution Phase (Ordered) 

		// Step 2a: Batch Destructions (from destroyEntitiesInQuery).
		if (this._batchDestructions.length > 0) {
			this._flushBatchDestructions()
		}

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
					break
				case 'destroyEntity':
					this._deletions.add(command.entityId)
					this._modifications.delete(command.entityId) // A destruction overrides any pending modifications.
					break
				case 'addComponent':
				case 'setComponentData': {
					if (this._deletions.has(command.entityId)) continue

					if (!this._modifications.has(command.entityId)) {
						this._modifications.set(command.entityId, this._getModObject())
					}
					const mod = this._modifications.get(command.entityId)
					mod.additions.set(command.componentTypeID, command.data)
					mod.removals.delete(command.componentTypeID) // An add/set overrides a remove.
					break
				}
				case 'removeComponent': {
					if (this._deletions.has(command.entityId)) continue

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
				const entityIndex = this.entityManager.entityIndexInArchetype[entityId]
				if (entityIndex !== undefined) {
					if (!inPlaceDataUpdates.has(sourceArchetypeId)) {
						inPlaceDataUpdates.set(sourceArchetypeId, [])
					}
					inPlaceDataUpdates.get(sourceArchetypeId).push({ entityIndex, componentsToUpdate: mod.additions })
				}
			} else {
				const sourceArchetypeData = this.archetypeManager.getData(sourceArchetypeId)
				const targetArchetypeMask = (sourceArchetypeData.mask | addMask) & ~removeMask
				const targetArchetypeId = this.archetypeManager.getArchetypeByMask(targetArchetypeMask)

				// OPTIMIZATION: Use a columnar data structure for moves to avoid per-entity object allocation.
				// This significantly reduces GC pressure during heavy structural changes.
				if (!moves.has(sourceArchetypeId)) moves.set(sourceArchetypeId, new Map())
				const sourceMoves = moves.get(sourceArchetypeId)
				if (!sourceMoves.has(targetArchetypeId)) {
					sourceMoves.set(targetArchetypeId, { entityIds: [], componentsToAssignArrays: [] })
				}
				const targetMoveData = sourceMoves.get(targetArchetypeId)
				targetMoveData.entityIds.push(entityId)
				targetMoveData.componentsToAssignArrays.push(mod.additions)
			}
		}

		for (const [archetypeId, updates] of inPlaceDataUpdates.entries()) {
			// Use the new, more efficient batch update method on the archetype.
			this.archetypeManager.setEntitiesComponents(archetypeId, updates, this.systemManager.currentTick)
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

	/**
	 * A generalized helper to process query-based component additions or removals.
	 * This reduces code duplication between `addComponentToQuery` and `removeComponentFromQuery`.
	 * @param {object} command - The command object.
	 * @param {Map} moves - The moves map to populate.
	 * @param {boolean} isAdd - True if adding a component, false if removing.
	 * @private
	 */
	_processQueryMove(command, moves, isAdd) {
		const { query, componentTypeID } = command
		const componentsToAssign = isAdd ? new Map([[componentTypeID, command.data]]) : new Map()
		const transitionCacheKey = isAdd ? 'add' : 'remove' // For caching the result
		const componentBitFlag = this.componentManager.componentBitFlags[componentTypeID]

		for (const chunk of query.iter()) {
			const sourceArchetypeData = chunk.archetype
			let targetArchetypeId = sourceArchetypeData.transitions[transitionCacheKey][componentTypeID]
			if (targetArchetypeId === undefined) {
				const targetArchetypeMask = isAdd ? sourceArchetypeData.mask | componentBitFlag : sourceArchetypeData.mask & ~componentBitFlag
				targetArchetypeId = this.archetypeManager.getArchetypeByMask(targetArchetypeMask)
				sourceArchetypeData.transitions[transitionCacheKey][componentTypeID] = targetArchetypeId
			}

			// OPTIMIZATION: Directly populate the columnar move data structure.
			const sourceMoves = moves.get(sourceArchetypeData.id) || moves.set(sourceArchetypeData.id, new Map()).get(sourceArchetypeData.id)
			let targetMoveData = sourceMoves.get(targetArchetypeId)
			if (!targetMoveData) {
				targetMoveData = { entityIds: [], componentsToAssignArrays: [] }
				sourceMoves.set(targetArchetypeId, targetMoveData)
			}

			for (const entityIndex of chunk) {
				const entityId = sourceArchetypeData.entities[entityIndex]
				if (this._deletions.has(entityId) || this._modifications.has(entityId)) continue
				targetMoveData.entityIds.push(entityId)
				targetMoveData.componentsToAssignArrays.push(componentsToAssign)
			}
		}
	}

	_processSetComponentDataOnQuery(command) {
		const { query, componentTypeID, data } = command
		for (const chunk of query.iter()) {
			const archetypeData = chunk.archetype
			const entitiesToUpdate = []
			let hasConflictingMod = false

			// Single pass to categorize entities in the chunk
			for (const entityIndex of chunk) {
				const entityId = archetypeData.entities[entityIndex]
				if (this._deletions.has(entityId) || this._modifications.has(entityId)) {
					hasConflictingMod = true
				} else {
					entitiesToUpdate.push(entityIndex)
				}
			}

			// If there were no conflicts, we can use the hyper-optimized full-chunk update.
			if (!hasConflictingMod) {
				this.archetypeManager.setChunkComponents(archetypeData.id, chunk, componentTypeID, data, this.systemManager.currentTick)
			} else if (entitiesToUpdate.length > 0) {
				// If there were conflicts, we must fall back to a batched update for the non-conflicted entities.
				// OPTIMIZATION: Avoid creating a new Map for every entity. Create one and share the reference.
				// This significantly reduces GC pressure when many entities have conflicting modifications.
				const componentsToUpdate = new Map([[componentTypeID, data]])
				const batchedUpdates = entitiesToUpdate.map(entityIndex => ({ entityIndex, componentsToUpdate }))
				this.archetypeManager.setEntitiesComponents(archetypeData.id, batchedUpdates, this.systemManager.currentTick)
			} else {
				// This chunk had conflicts on every entity, so there's nothing to do.
			}
		}
	}

	/**
	 * A private helper that processes all `destroyEntitiesInQuery` commands.
	 * @private
	 */
	_flushBatchDestructions() {
		for (const command of this._batchDestructions) {
			const { query } = command
			for (const chunk of query.iter()) {
				for (const entityIndex of chunk) {
					const entityId = chunk.archetype.entities[entityIndex]
					this._deletions.add(entityId)
					this._modifications.delete(entityId)
				}
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
		}		if (dataDriven.size > 0) {
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
		const overridesArray = new Array(count).fill(overrides)
		return this._executeInstantiateWithData(prefabId, overridesArray)
	}

	/**
	 * The core logic for all data-driven prefab creation.
	 * @param {string} prefabId
	 * @param {object[]} overridesArray
	 * @returns {number[]} An array of the created root entity IDs.
	 * @private
	 */
	_executeInstantiateWithData(prefabId, overridesArray) {
		const prefabData = this.prefabManager.getPrefabDataSync(prefabId)
		if (!prefabData) {
			console.error(`CommandBufferExecutor: Could not instantiate data-driven prefab '${prefabId}'. Not found or preloaded.`)
			return []
		}

		const count = overridesArray.length

		const _recursiveBatchCreator = (nodeData, parentIds, rootIds, levelOverrides) => {
			const componentDataArray = this._prepareComponentDataForBatch(
				nodeData,
				count,
				parentIds,
				rootIds,
				levelOverrides
			)
			const creationsByArchetype = this._groupComponentMapsByArchetype(componentDataArray)
			const newEntityIds = this._createEntitiesByArchetype(creationsByArchetype, count)

			if (nodeData.children && nodeData.children.length > 0) {
				for (const childData of nodeData.children) {
					_recursiveBatchCreator(childData, newEntityIds, rootIds || newEntityIds, null)
				}
			}
			return newEntityIds
		}

		const rootNodeData = { ...prefabData, components: { ...prefabData.components, PrefabId: { id: prefabId } } }
		return _recursiveBatchCreator(rootNodeData, null, null, overridesArray)
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

		// Phase 1: Group all creation requests by their resulting archetype.
		for (let i = 0; i < creationData.length; i++) {
			const componentsInput = creationData[i]
			const componentIdMap = this.entityManager._convertComponentDataToIdMap(componentsInput)

			// OPTIMIZATION: Generate the archetype mask directly from the component keys
			// without creating an intermediate array and sorting it. This is much faster.
			const archetypeMask = this.archetypeManager.generateArchetypeMask(componentIdMap.keys())
			const archetypeId = this.archetypeManager.getArchetypeByMask(archetypeMask)

			if (!creationsByArchetype.has(archetypeId)) {
				creationsByArchetype.set(archetypeId, [])
			}
			creationsByArchetype.get(archetypeId).push({ originalIndex: i, componentIdMap })
		}

		// Phase 2 & 3: Execute creations and map IDs back to original order.
		return this._createEntitiesByArchetype(creationsByArchetype, creationData.length)
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
				const prefabData = this.prefabManager.getPrefabDataSync(prefabName)
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
	_createEntitiesByArchetype(creationsByArchetype, totalCreations) {
		const allNewIds = new Array(totalCreations)

		for (const [archetypeId, creationGroup] of creationsByArchetype.entries()) {
			const componentIdMapsForBatch = creationGroup.map(item => item.componentIdMap)
			const newIdsForBatch = this.entityManager.createEntitiesInArchetype(archetypeId, componentIdMapsForBatch)
			for (let i = 0; i < newIdsForBatch.length; i++) {
				const originalIndex = creationGroup[i].originalIndex
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
		const baseComponentIdMap = this.entityManager._convertComponentDataToIdMap(nodeData.components)
		const parentComponentTypeId = parentIds
			? this.componentManager.getComponentTypeID(this.componentManager.getComponentClassByName('Parent'))
			: -1
		const ownerComponentTypeId = rootIds
			? this.componentManager.getComponentTypeID(this.componentManager.getComponentClassByName('Owner'))
			: -1

		for (let i = 0; i < count; i++) {
			const map = new Map(baseComponentIdMap)
			if (levelOverrides) {
				const overrideIdMap = this.entityManager._convertComponentDataToIdMap(levelOverrides[i])
				for (const [key, value] of overrideIdMap.entries()) map.set(key, value)
			}
			if (parentIds) map.set(parentComponentTypeId, { entityId: parentIds[i] })
			if (rootIds) map.set(ownerComponentTypeId, { entityId: rootIds[i] })
			componentMaps.push(map)
		}
		return componentMaps
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