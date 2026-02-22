import { OpCodes } from './CommandOpcodes.js'
import { CommandBufferReader } from './CommandBufferReader.js'
import * as Schema from '../ComponentManager/ComponentSchema.js'
import { entityStore } from '../EntityManager/EntityManager.js'

const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
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
	constructor() {
		this.entityManager = engine.getManager('ECS').entityManager
		this.prefabManager = engine.getManager('ECS').prefabManager
		this.queryManager = engine.getManager('ECS').queryManager
		this._currentCommandBuffer = null // To avoid passing it down through every function call
	}

	/**
	 * Executes all commands queued in the provided CommandBuffer.
	 * @param {import('./CommandBuffer.js').CommandBuffer} commandBuffer
	 * @param {number} currentTick The current game tick for timestamping changes.
	 */
	execute(commandBuffer, currentTick) {
		const { sortedOffsets } = commandBuffer.getSortedCommands()
		if (sortedOffsets.length === 0) return

		this._currentCommandBuffer = commandBuffer

		const reader = new CommandBufferReader(commandBuffer.rawBuffer)

		// --- 1. Consolidation Pass ---
		// Group commands by type for batch processing.
		// --- OPTIMIZATION: Zero-Allocation Consolidation ---
		// Instead of pushing objects `{entityId, payload}` which causes GC pressure,
		// we use parallel TypedArrays to store command data.
		const creations = { identical: [], varied: [] }
		const modifications = {
			// This now stores binary payload modification commands
			add: new Map(), // Map<componentTypeID, { entityIds: number[], dataOffsets: number[], dataLengths: number[] }>
			remove: new Map(), // Map<componentTypeID, number[]>
			set: new Map(), // Map<componentTypeID, { entityIds: number[], soaIndices: number[] }>
		}
		const deletions = new Set()
		const chunkDeletions = new Set()

		for (let i = 0; i < sortedOffsets.length; i++) {
			reader.seek(sortedOffsets[i])
			const opCode = reader.readU8()

			switch (opCode) {
				// --- Deletion Phase Commands ---
				case OpCodes.DESTROY_ENTITY: {
					const entityId = reader.readU64()
					deletions.add(entityId)
					break
				}
				case OpCodes.DESTROY_ENTITIES_IN_CHUNK: {
					const chunkId = reader.readU16()
					chunkDeletions.add(chunkId)
					break
				}

				// --- Modification Phase Commands ---
				case OpCodes.ADD_COMPONENT: {
					const entityId = reader.readU64()
					if (deletions.has(entityId)) continue // Skip mods on deleted entities
					const componentTypeID = reader.readU16()
					const dataLength = reader.readU16()
					const dataOffset = reader.offset // The offset where the binary data starts

					if (!modifications.add.has(componentTypeID)) {
						modifications.add.set(componentTypeID, { entityIds: [], dataOffsets: [], dataLengths: [] })
					}
					const addBatch = modifications.add.get(componentTypeID)
					addBatch.dataLengths.push(dataLength)
					addBatch.entityIds.push(entityId)
					addBatch.dataOffsets.push(dataOffset)
					break
				}
				case OpCodes.REMOVE_COMPONENT: {
					const entityId = reader.readU64()
					if (deletions.has(entityId)) continue
					const componentTypeID = reader.readU16()
					if (!modifications.remove.has(componentTypeID)) modifications.remove.set(componentTypeID, [])
					modifications.remove.get(componentTypeID).push(entityId)
					break
				}
				case OpCodes.SET_COMPONENT_DATA: {
					const entityId = reader.readU64()
					if (deletions.has(entityId)) continue
					const componentTypeID = reader.readU16()
					const dataLength = reader.readU16()
					const dataOffset = reader.offset

					if (!modifications.set.has(componentTypeID)) {
						modifications.set.set(componentTypeID, { entityIds: [], dataOffsets: [], dataLengths: [] })
					}
					const setBatch = modifications.set.get(componentTypeID)
					setBatch.entityIds.push(entityId)
					setBatch.dataOffsets.push(dataOffset)
					setBatch.dataLengths.push(dataLength)



					break
				}

				// --- Creation Phase Commands ---
				case OpCodes.CREATE_ENTITY: {
					// Reads the new binary SoA payload format.
					const archetypeId = reader.readU16()
					const dataSize = reader.readU16()
					const payload = reader.readBuffer(dataSize)

					// The payload is a binary blob, just like the identical-creation path.
					creations.varied.push({ archetypeId, payload })
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
		this.entityManager.destroyEntitiesInBatch(deletions)

		for (const chunkId of chunkDeletions) {
			this.entityManager.destroyAllEntitiesInChunk(chunkId)
		}

		// --- Modification ---
		this._buildAndExecuteMoveBatches(modifications, reader, currentTick)
		this._executeSetDataBatches(modifications.set, reader, currentTick)

		// --- Creation ---
		for (const { archetypeId, payload } of creations.varied) {
			this.entityManager.createEntityFromBinarySoAPayload(archetypeId, payload, currentTick)
		}

		for (const { count, archetypeId, payload } of creations.identical) {
			this.entityManager.createIdenticalEntitiesInArchetype(archetypeId, payload, count, currentTick)
		}

		// Cleanup
		commandBuffer.clear()
		this._currentCommandBuffer = null
	}

	/**
	 * The new, optimized "Gather-and-Blit" function for structural changes.
	 * It gathers all `addComponent` and `removeComponent` commands, groups them by
	 * source chunk and target archetype, and then executes them in batches.
	 * @param {object} modifications The consolidated modification commands.
	 * @param {CommandBufferReader} reader The reader for the raw command buffer.
	 * @param {number} currentTick The current game tick.
	 * @private
	 */
	_buildAndExecuteMoveBatches(modifications, reader, currentTick) {
		// The new batching structure: Map<sourceChunk, Map<targetArchetypeId, moveBatch>>
		// moveBatch = { entityIds: number[], sourceIndices: number[], componentsToAssign: Map<typeId, { dataOffsets: number[], dataLengths: number[] }> }
		const movesByChunk = new Map()

		// Process additions (SoA path)
		for (const [componentTypeID, addBatch] of modifications.add.entries()) {
			const { entityIds, dataOffsets, dataLengths } = addBatch
			for (let i = 0; i < entityIds.length; i++) {
				const entityId = entityIds[i]
				const sourceArchetypeId = this.entityManager.getArchetypeForEntity(entityId)
				if (sourceArchetypeId === undefined) continue

				const location = this.entityManager.getEntityLocation(entityId)
				if (!location || this.entityManager.hasComponentType(sourceArchetypeId, componentTypeID)) continue

				const sourceChunkId = location.chunkId
				const targetArchetypeId = this.entityManager.getArchetypeByMask(
					entityStore.archetypeMasks[sourceArchetypeId] | Schema.componentBitFlags[componentTypeID]
				)

				// --- Gather into the new batch structure ---
				if (!movesByChunk.has(sourceChunkId)) movesByChunk.set(sourceChunkId, new Map())
				const chunkMoves = movesByChunk.get(sourceChunkId)

				if (!chunkMoves.has(targetArchetypeId)) {
					chunkMoves.set(targetArchetypeId, {
						entityIds: [],
						sourceIndices: [],
						componentsToAssign: new Map(),
					})
				}
				const moveBatch = chunkMoves.get(targetArchetypeId)
				moveBatch.entityIds.push(entityId)
				moveBatch.sourceIndices.push(location.indexInChunk)

				// Add the component data to be assigned
				if (!moveBatch.componentsToAssign.has(componentTypeID)) {
					moveBatch.componentsToAssign.set(componentTypeID, { dataOffsets: [], dataLengths: [] })
				}
				moveBatch.componentsToAssign.get(componentTypeID).dataOffsets.push(dataOffsets[i])
				moveBatch.componentsToAssign.get(componentTypeID).dataLengths.push(dataLengths[i])
			}
		}

		// Process removals
		for (const [componentTypeID, entityIds] of modifications.remove.entries()) {
			for (const entityId of entityIds) {
				const sourceArchetypeId = this.entityManager.getArchetypeForEntity(entityId)
				if (sourceArchetypeId === undefined) continue

				const location = this.entityManager.getEntityLocation(entityId)
				if (!location || !this.entityManager.hasComponentType(sourceArchetypeId, componentTypeID)) continue

				const sourceChunkId = location.chunkId
				const targetArchetypeId = this.entityManager.getArchetypeByMask(
					entityStore.archetypeMasks[sourceArchetypeId] & ~Schema.componentBitFlags[componentTypeID]
				)

				// --- Gather into the new batch structure ---
				if (!movesByChunk.has(sourceChunkId)) movesByChunk.set(sourceChunkId, new Map())
				const chunkMoves = movesByChunk.get(sourceChunkId)

				if (!chunkMoves.has(targetArchetypeId)) {
					chunkMoves.set(targetArchetypeId, { entityIds: [], sourceIndices: [], componentsToAssign: new Map() }) // ew
				}
				const moveBatch = chunkMoves.get(targetArchetypeId)
				moveBatch.entityIds.push(entityId)
				moveBatch.sourceIndices.push(location.indexInChunk)
			}
		}

		// --- Blit Pass ---
		// Now execute batches.
		for (const [sourceChunkId, targets] of movesByChunk.entries()) {
			for (const [targetArchetypeId, moveBatch] of targets.entries()) {
				const { entityIds, sourceIndices, componentsToAssign } = moveBatch
				const sourceLocations = sourceIndices.map(indexInChunk => ({ chunkId: sourceChunkId, indexInChunk }))
				const sourceArchetypeId = entityStore.chunkArchetypeIds[sourceChunkId]

				this.entityManager._addEntitiesByCopyingBatch(
					targetArchetypeId,
					sourceArchetypeId,
					sourceLocations,
					entityIds,
					componentsToAssign,
					reader,
					currentTick
				)
				this.entityManager._removeEntitiesBatch(sourceArchetypeId, entityIds)
			}
		}
	}

	_executeSetDataBatches(setDataMap, reader, currentTick) {
		for (const [componentTypeID, sets] of setDataMap.entries()) {
			const info = Schema.componentInfo[componentTypeID]
			if (!info) continue

			// --- 1. Gather Pass ---
			// First, group all modifications by their destination chunk.
			const setsByChunk = new Map() // Map<chunkId, { destIndices: number[], dataOffsets: number[], dataLengths: number[] }>
			const { entityIds, dataOffsets, dataLengths } = sets
			for (let i = 0; i < entityIds.length; i++) {
				const entityId = entityIds[i]
				const location = this.entityManager.getEntityLocation(entityId)
				if (!location) continue

				// Developer is responsible for ensuring the entity has the component.
				const chunkId = location.chunkId
				if (!setsByChunk.has(chunkId)) {
					setsByChunk.set(chunkId, { destIndices: [], dataOffsets: [], dataLengths: [] })
				}
				const batch = setsByChunk.get(chunkId)
				batch.destIndices.push(location.indexInChunk)
				batch.dataOffsets.push(dataOffsets[i])
				batch.dataLengths.push(dataLengths[i])
			}

			// --- 2. Blit Pass ---
			for (const [chunkId, batch] of setsByChunk.entries()) {
				this.entityManager._blitComponentDataFromBinary(
					chunkId,
					componentTypeID,
					batch.destIndices,
					batch.dataOffsets,
					batch.dataLengths,
					reader,
					currentTick
				)
			}
		}
	}
}
