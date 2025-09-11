import { OpCodes } from './CommandOpcodes.js'
import { CommandBufferReader } from './CommandBufferReader.js'


/**
 * Executes commands from a pre-sorted CommandBuffer using a consolidation and batching strategy.
 *
 * This executor first consolidates all commands into batches (e.g., all creations, all deletions, all modifications of a certain type).
 * It then executes these batches, leveraging highly optimized, archetype-aware methods in the EntityManager and ArchetypeManager.
 * This approach maximizes cache efficiency by processing entities in contiguous groups rather than one at a time.
 * Processes the command buffer, applying all queued structural changes to the world state.
 * 
 * 
 * 
 * Gather-and-Blit
 */
export class CommandBufferExecutor {
	/**
	 * @param {import('../EntityManager/EntityManager.js').EntityManager} entityManager
	 * @param {import('../ComponentManager/ComponentManager.js').ComponentManager} componentManager
	 * @param {import('../ArchetypeManager/ArchetypeManager.js').ArchetypeManager} archetypeManager
	 * @param {import('./SystemManager.js').SystemManager} systemManager
	 * @param {import('../PrefabManager/PrefabManager.js').PrefabManager} prefabManager
	 */
	constructor(entityManager, componentManager, archetypeManager, systemManager, prefabManager) {
		this.entityManager = entityManager
		this.componentManager = componentManager
		this.archetypeManager = archetypeManager
		this.systemManager = systemManager
		this.prefabManager = prefabManager
		this._currentCommandBuffer = null // To avoid passing it down through every function call
	}

	/**
	 * Executes all commands queued in the provided CommandBuffer.
	 * @param {import('./CommandBuffer.js').CommandBuffer} commandBuffer
	 */
	execute(commandBuffer) {
		const { sortedOffsets } = commandBuffer.getSortedCommands()
		if (sortedOffsets.length === 0) return

		this._currentCommandBuffer = commandBuffer

		const reader = new CommandBufferReader(commandBuffer.rawBuffer, this.componentManager)
		const currentTick = this.systemManager.currentTick

		// --- 1. Consolidation Pass ---
		// Group commands by type for batch processing.
		// --- OPTIMIZATION: Zero-Allocation Consolidation ---
		// Instead of pushing objects `{entityId, payload}` which causes GC pressure,
		// we use parallel TypedArrays to store command data.
		const creations = { identical: [], varied: [] }
		const modifications = {
			// This now stores SoA modification commands
			add: new Map(), // Map<componentTypeID, { entityIds: number[], soaIndices: number[] }>
			remove: new Map(), // Map<componentTypeID, number[]>
			set: new Map(), // Map<componentTypeID, { entityIds: number[], soaIndices: number[] }>
		}
		const deletions = { entities: new Set(), queries: new Set() }
		const queryMods = { add: [], remove: [], set: [] }

		for (let i = 0; i < sortedOffsets.length; i++) {
			reader.seek(sortedOffsets[i])
			const opCode = reader.readU8()

			switch (opCode) {
				// --- Deletion Phase Commands ---
				case OpCodes.DESTROY_ENTITY: {
					const entityId = reader.readU32()
					deletions.entities.add(entityId)
					break
				}
				case OpCodes.DESTROY_ENTITIES_IN_QUERY: {
					const queryId = reader.readU32()
					deletions.queries.add(queryId)
					break
				}

				// --- Modification Phase Commands ---
				case OpCodes.ADD_COMPONENT: {
					const entityId = reader.readU32()
					if (deletions.entities.has(entityId)) continue // Skip mods on deleted entities
					const componentTypeID = reader.readU16()
					const soaIndex = reader.readU32()

					if (!modifications.add.has(componentTypeID)) {
						modifications.add.set(componentTypeID, { entityIds: [], soaIndices: [] })
					}
					const addBatch = modifications.add.get(componentTypeID)
					addBatch.entityIds.push(entityId)
					addBatch.soaIndices.push(soaIndex)
					break
				}
				case OpCodes.REMOVE_COMPONENT: {
					const entityId = reader.readU32()
					if (deletions.entities.has(entityId)) continue
					const componentTypeID = reader.readU16()
					if (!modifications.remove.has(componentTypeID)) modifications.remove.set(componentTypeID, [])
					modifications.remove.get(componentTypeID).push(entityId)
					break
				}
				case OpCodes.SET_COMPONENT_DATA: {
					const entityId = reader.readU32()
					if (deletions.entities.has(entityId)) continue
					const componentTypeID = reader.readU16()
					const soaIndex = reader.readU32()

					if (!modifications.set.has(componentTypeID)) {
						modifications.set.set(componentTypeID, { entityIds: [], soaIndices: [] })
					}
					const setBatch = modifications.set.get(componentTypeID)
					setBatch.entityIds.push(entityId)
					setBatch.soaIndices.push(soaIndex)
					break
				}
				case OpCodes.ADD_COMPONENT_TO_QUERY: {
					const queryId = reader.readU32()
					const componentTypeID = reader.readU16()
					const soaIndex = reader.readU32()
					queryMods.add.push({ queryId, componentTypeID, soaIndex })
					break
				}
				case OpCodes.REMOVE_COMPONENT_FROM_QUERY: {
					const queryId = reader.readU32()
					const componentTypeID = reader.readU16()
					queryMods.remove.push({ queryId, componentTypeID })
					break
				}
				case OpCodes.SET_COMPONENT_DATA_ON_QUERY: {
					const queryId = reader.readU32()
					const componentTypeID = reader.readU16()
					const soaIndex = reader.readU32()
					queryMods.set.push({ queryId, componentTypeID, soaIndex })
					break
				}

				// --- Creation Phase Commands ---
				case OpCodes.CREATE_ENTITY: {
					const archetypeId = reader.readU16()
					const componentCount = reader.readU16();
					const componentsToAssign = new Map();
					for (let j = 0; j < componentCount; j++) {
						const typeID = reader.readU16();
						const soaIndex = reader.readU32();
						componentsToAssign.set(typeID, { soaIndex });
					}
					// The varied array now holds SoA-based creation commands.
					// The 'payload' is now the map of components to assign.
					creations.varied.push({ archetypeId, payload: componentsToAssign })
					break
				}
				case OpCodes.CREATE_ENTITIES_IDENTICAL: {
					const count = reader.readU32()
					const archetypeId = reader.readU16()
					const dataSize = reader.readU16()
					const payload = reader.readBuffer(dataSize)
					creations.identical.push({ count, archetypeId, payload })
					break
				}
			}
		}

		// --- 2. Execution Pass ---
		// Execute consolidated batches in the correct order: Destroy > Modify > Create

		// --- Deletion ---
		for (const queryId of deletions.queries) {
			const query = this.systemManager.queryManager.getQueryById(queryId)
			if (query) this.entityManager.destroyEntitiesInQuery(query)
		}
		this.entityManager.destroyEntitiesInBatch(deletions.entities)

		// --- Modification ---
		const moves = this.buildMoveBatches(modifications)
		if (moves.size > 0) {
			this.archetypeManager.moveEntitiesInBatch(moves)
		}
		this.executeSoASetDataBatches(modifications.set)

		// --- Query-based Modifications ---
		for (const { queryId, componentTypeID, soaIndex } of queryMods.add) {
			const query = this.systemManager.queryManager.getQueryById(queryId)
			if (query) this.archetypeManager.addComponentToQuery(query, componentTypeID, soaIndex)
		}
		for (const { queryId, componentTypeID } of queryMods.remove) {
			const query = this.systemManager.queryManager.getQueryById(queryId)
			if (query) this.archetypeManager.removeComponentFromQuery(query, componentTypeID)
		}
		for (const { queryId, componentTypeID, soaIndex } of queryMods.set) {
			const query = this.systemManager.queryManager.getQueryById(queryId)
			if (query) this.archetypeManager.setComponentDataOnQuery(query, componentTypeID, soaIndex)
		}

		// --- Creation ---
		for (const { archetypeId, payload } of creations.varied) {
			this.entityManager.createEntityFromSoA(archetypeId, payload)
		}
		for (const { count, archetypeId, payload } of creations.identical) {
			this.entityManager.createIdenticalEntitiesInArchetype(archetypeId, payload, count)
		}

		// Cleanup
		commandBuffer.clear()
		this._currentCommandBuffer = null
	}

	buildMoveBatches(modifications) {
		const moves = new Map() // Map<sourceArchetypeId, Map<targetArchetypeId, { entityIds: [], componentsToAssign: Map<typeID, {offsets:[], sizes:[]}> }>>

		// Process additions (SoA path)
		for (const [componentTypeID, addBatch] of modifications.add.entries()) {
			const { entityIds, soaIndices } = addBatch
			for (let i = 0; i < entityIds.length; i++) {
				const entityId = entityIds[i]
				const sourceArchetypeId = this.entityManager.getArchetypeForEntity(entityId)
				if (sourceArchetypeId === undefined || this.archetypeManager.hasComponentType(sourceArchetypeId, componentTypeID)) continue

				const targetArchetypeId = this.archetypeManager.getArchetypeByMask(
					this.archetypeManager.archetypeMasks[sourceArchetypeId] | this.componentManager.componentBitFlags[componentTypeID]
				)

				// Pass the SoA index instead of payload offsets
				const componentsToAssign = new Map([[componentTypeID, { soaIndex: soaIndices[i] }]])

				this.archetypeManager._addMoveToBatch(moves, sourceArchetypeId, targetArchetypeId, entityId, componentsToAssign)
			}
		}

		// Process removals
		for (const [componentTypeID, entityIds] of modifications.remove.entries()) {
			for (const entityId of entityIds) {
				const sourceArchetypeId = this.entityManager.getArchetypeForEntity(entityId)
				if (sourceArchetypeId === undefined || !this.archetypeManager.hasComponentType(sourceArchetypeId, componentTypeID)) continue

				const targetArchetypeId = this.archetypeManager.getArchetypeByMask(
					this.archetypeManager.archetypeMasks[sourceArchetypeId] & ~this.componentManager.componentBitFlags[componentTypeID]
				)
				this.archetypeManager._addMoveToBatch(moves, sourceArchetypeId, targetArchetypeId, entityId, new Map())
			}
		}

		return moves
	}

	executeSoASetDataBatches(setDataMap) {
		const sourceSoaBuffers = this._currentCommandBuffer.soaData;

		for (const [componentTypeID, sets] of setDataMap.entries()) {
			const info = this.componentManager.componentInfo[componentTypeID];
			if (!info) continue;

			// --- 1. Gather Pass ---
			// First, group all modifications by their destination chunk.
			const setsByChunk = new Map()
			const { entityIds, soaIndices } = sets
			for (let i = 0; i < entityIds.length; i++) {
				const entityId = entityIds[i]
				const location = this.entityManager.archetypeManager.archetypeEntityMaps[this.entityManager.entityArchetype[entityId]]?.get(entityId);
				if (!location) continue;

				if (!setsByChunk.has(location.chunk)) {
					setsByChunk.set(location.chunk, { destIndices: [], soaIndices: [] });
				}
				const batch = setsByChunk.get(location.chunk);
				batch.destIndices.push(location.indexInChunk);
				batch.soaIndices.push(soaIndices[i]);
			}

			// --- 2. Blit Pass ---
			// Now, for each chunk, "blit" the gathered data in a bulk operation.
			for (const [chunk, batch] of setsByChunk.entries()) {
				const { destIndices, soaIndices } = batch;
				const sourceSoaArrays = sourceSoaBuffers[componentTypeID];
				const destSoaArrays = chunk.componentArrays[componentTypeID];				
				this.archetypeManager._blitComponentDataFromSoA(
					chunk,
					componentTypeID,
					destSoaArrays,
					sourceSoaArrays,
					destIndices,
					soaIndices
				);
			}
		}
	}
}
