import { OpCodes } from './CommandOpcodes.js'
import { CommandBufferReader } from './CommandBufferReader.js'
import * as Schema from '../ComponentManager/ComponentSchema.js'
import { entityStore, MASK_PARTS } from '../EntityManager/EntityManager.js'
import { entityMaskManager } from '../EntityMaskManager/EntityMaskManager.js'

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
	constructor(entityManager, prefabManager, queryManager) {
		this.entityManager = entityManager
		this.prefabManager = prefabManager
		this.queryManager = queryManager
		this.entityMaskManager = entityMaskManager

		// --- Pre-allocated data structures to reduce GC pressure ---
		this._creations = { identical: [], varied: [] }
		this._modifications = {
			add: new Map(),
			remove: new Map(),
			set: new Map(),
			setSilent: new Map(),
		}
		this._deferredModifications = {
			add: [],
			remove: [],
			set: [],
			setSilent: [],
			addComponents: [],
			setComponents: [],
			setComponentsSilent: [],
		}
		this._deferredBatching = {
			add: new Map(),
			remove: new Map(),
			set: new Map(),
			setSilent: new Map(),
		}
		this._placeholderResolutionMap = new Map()
		this._deletions = new Set()
		this._chunkDeletions = new Set()
		this._entityTransitions = new Map()
		this._movesByChunk = new Map()
		this._removalsByArchetype = new Map()
		this._trackableIdsBuffer = []
	}

	/**
	 * Executes all commands queued in the provided CommandBuffer.
	 * @param {import('./CommandBuffer.js').CommandBuffer} commandBuffer The command buffer to execute.
	 * @param {number} timestampTick The tick value to use for timestamping all dirty changes.
	 */
	execute(commandBuffer, timestampTick) {
		const { sortedOffsets } = commandBuffer.getSortedCommands()
		if (sortedOffsets.length === 0) return

		const reader = new CommandBufferReader(commandBuffer.rawBuffer)

		// --- 1. Consolidation Pass ---
		// Group commands by type for batch processing.
		// We use pre-allocated class properties and clear them to avoid GC pressure.
		const creations = this._creations
		creations.identical.length = 0
		creations.varied.length = 0

		const modifications = this._modifications
		modifications.add.clear()
		modifications.remove.clear()
		modifications.set.clear()
		modifications.setSilent.clear()

		const deferredModifications = this._deferredModifications
		deferredModifications.add.length = 0
		deferredModifications.set.length = 0
		deferredModifications.setSilent.length = 0
		deferredModifications.remove.length = 0
		deferredModifications.addComponents.length = 0
		deferredModifications.setComponents.length = 0
		deferredModifications.setComponentsSilent.length = 0

		const placeholderResolutionMap = this._placeholderResolutionMap
		placeholderResolutionMap.clear()

		const deletions = this._deletions
		deletions.clear()

		const chunkDeletions = this._chunkDeletions
		chunkDeletions.clear()

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
				case OpCodes.DESTROY_BY_QUERY: {
					const queryId = reader.readU32()
					const query = this.queryManager.getQueryById(queryId)
					if (query) this.entityManager.destroyEntitiesInArchetypes(query.getArchetypes())
					break
				}

				// --- Modification Phase Commands ---
				case OpCodes.ADD_COMPONENT: {
					const entityId = reader.readU64()
					if (entityId >> 63n === 1n) {
						// Defer modifications on placeholder entities
						deferredModifications.add.push(sortedOffsets[i])
						continue
					}
					if (deletions.has(entityId)) continue // Skip mods on deleted entities
					const componentTypeID = reader.readU16()
					const dataLength = reader.readU16()
					const dataOffset = reader.offset // The offset where the binary data starts
					reader.seek(reader.offset + dataLength)
					const trackableIdsCount = reader.readU8()
					const trackableIds = this._trackableIdsBuffer
					trackableIds.length = 0
					for (let j = 0; j < trackableIdsCount; j++) {
						trackableIds.push(reader.readU16())
					}

					if (!modifications.add.has(componentTypeID)) {
						modifications.add.set(componentTypeID, [])
					}
					modifications.add
						.get(componentTypeID)
						.push({ entityId, dataOffset, dataLength, trackableIds: [...trackableIds] })
					break
				}
				case OpCodes.ADD_COMPONENTS: {
					const entityId = reader.readU64()
					if (entityId >> 63n === 1n) {
						// Defer modifications on placeholder entities
						deferredModifications.addComponents.push(sortedOffsets[i])
						continue
					}
					if (deletions.has(entityId)) continue // Skip mods on deleted entities

					const payloadArchetypeId = reader.readU16()
					const dataLength = reader.readU16()
					const payloadDataOffset = reader.offset // The offset where the AoS binary data starts
					reader.seek(reader.offset + dataLength)
					const trackableIdsCount = reader.readU8()
					const trackableIds = this._trackableIdsBuffer
					trackableIds.length = 0
					for (let j = 0; j < trackableIdsCount; j++) {
						trackableIds.push(reader.readU16())
					}

					const componentIds = this.entityManager.getComponentTypeIDsForArchetype(payloadArchetypeId)

					let componentRelativeOffset = 0
					for (const componentTypeID of componentIds) {
						const info = Schema.componentInfo[componentTypeID]

						// Handle alignment within the AoS payload
						const alignment = info.alignment
						if (alignment > 0 && componentRelativeOffset % alignment !== 0) {
							componentRelativeOffset += alignment - (componentRelativeOffset % alignment)
						}

						if (!modifications.add.has(componentTypeID)) {
							modifications.add.set(componentTypeID, [])
						}
						modifications.add.get(componentTypeID).push({
							entityId,
							dataOffset: payloadDataOffset + componentRelativeOffset,
							dataLength: info.byteSize,
							trackableIds: [...trackableIds],
						})
						componentRelativeOffset += info.byteSize
					}
					break
				}
				case OpCodes.SET_COMPONENTS: {
					const entityId = reader.readU64()
					if (entityId >> 63n === 1n) {
						// Defer modifications on placeholder entities
						deferredModifications.setComponents.push(sortedOffsets[i])
						continue
					}
					if (deletions.has(entityId)) continue // Skip mods on deleted entities

					const payloadArchetypeId = reader.readU16()
					const dataLength = reader.readU16()
					const payloadDataOffset = reader.offset // The offset where the AoS binary data starts
					reader.seek(reader.offset + dataLength)
					const trackableIdsCount = reader.readU8()
					const trackableIds = this._trackableIdsBuffer
					trackableIds.length = 0
					for (let j = 0; j < trackableIdsCount; j++) {
						trackableIds.push(reader.readU16())
					}

					const componentIds = this.entityManager.getComponentTypeIDsForArchetype(payloadArchetypeId)

					let componentRelativeOffset = 0
					for (const componentTypeID of componentIds) {
						const info = Schema.componentInfo[componentTypeID]

						// Handle alignment within the AoS payload
						const alignment = info.alignment
						if (alignment > 0 && componentRelativeOffset % alignment !== 0) {
							componentRelativeOffset += alignment - (componentRelativeOffset % alignment)
						}

						if (!modifications.set.has(componentTypeID)) {
							modifications.set.set(componentTypeID, [])
						}
						modifications.set.get(componentTypeID).push({
							entityId,
							dataOffset: payloadDataOffset + componentRelativeOffset,
							dataLength: info.byteSize,
							trackableIds: [...trackableIds],
						})
						componentRelativeOffset += info.byteSize
					}
					break
				}
				case OpCodes.SET_COMPONENTS_SILENT: {
					const entityId = reader.readU64()
					if (entityId >> 63n === 1n) {
						// Defer modifications on placeholder entities
						deferredModifications.setComponentsSilent.push(sortedOffsets[i])
						continue
					}
					if (deletions.has(entityId)) continue // Skip mods on deleted entities

					const payloadArchetypeId = reader.readU16()
					const dataLength = reader.readU16()
					const payloadDataOffset = reader.offset
					reader.seek(reader.offset + dataLength)
					const trackableIdsCount = reader.readU8()
					reader.seek(reader.offset + trackableIdsCount * 2)

					const componentIds = this.entityManager.getComponentTypeIDsForArchetype(payloadArchetypeId)

					let componentRelativeOffset = 0
					for (const componentTypeID of componentIds) {
						const info = Schema.componentInfo[componentTypeID]

						// Handle alignment within the AoS payload
						const alignment = info.alignment
						if (alignment > 0 && componentRelativeOffset % alignment !== 0) {
							componentRelativeOffset += alignment - (componentRelativeOffset % alignment)
						}

						if (!modifications.setSilent.has(componentTypeID)) {
							modifications.setSilent.set(componentTypeID, [])
						}
						modifications.setSilent.get(componentTypeID).push({
							entityId,
							dataOffset: payloadDataOffset + componentRelativeOffset,
							dataLength: info.byteSize,
						})
						componentRelativeOffset += info.byteSize
					}
					break
				}
				case OpCodes.REMOVE_COMPONENT: {
					const entityId = reader.readU64()
					if (entityId >> 63n === 1n) {
						// Defer modifications on placeholder entities
						deferredModifications.remove.push(sortedOffsets[i])
						continue
					}
					if (deletions.has(entityId)) continue
					const componentTypeID = reader.readU16()
					if (!modifications.remove.has(componentTypeID)) modifications.remove.set(componentTypeID, [])
					modifications.remove.get(componentTypeID).push(entityId)
					break
				}
				case OpCodes.SET_COMPONENT: {
					const entityId = reader.readU64()
					if (entityId >> 63n === 1n) {
						// Defer modifications on placeholder entities
						deferredModifications.set.push(sortedOffsets[i])
						continue
					}
					if (deletions.has(entityId)) continue
					const componentTypeID = reader.readU16()
					const dataLength = reader.readU16()
					const dataOffset = reader.offset
					reader.seek(reader.offset + dataLength)
					const trackableIdsCount = reader.readU8()
					const trackableIds = this._trackableIdsBuffer
					trackableIds.length = 0
					for (let j = 0; j < trackableIdsCount; j++) {
						trackableIds.push(reader.readU16())
					}

					if (!modifications.set.has(componentTypeID)) {
						modifications.set.set(componentTypeID, [])
					}
					modifications.set
						.get(componentTypeID)
						.push({ entityId, dataOffset, dataLength, trackableIds: [...trackableIds] })
					break
				}

				case OpCodes.SET_COMPONENT_SILENT: {
					const entityId = reader.readU64()
					if (entityId >> 63n === 1n) {
						// Defer modifications on placeholder entities
						deferredModifications.setSilent.push(sortedOffsets[i])
						continue
					}
					if (deletions.has(entityId)) continue
					const componentTypeID = reader.readU16()
					const dataLength = reader.readU16()
					const dataOffset = reader.offset
					reader.seek(reader.offset + dataLength)
					const trackableIdsCount = reader.readU8()
					reader.seek(reader.offset + trackableIdsCount * 2)

					if (!modifications.setSilent.has(componentTypeID)) {
						modifications.setSilent.set(componentTypeID, [])
					}
					modifications.setSilent.get(componentTypeID).push({ entityId, dataOffset, dataLength, trackableIds: [] })
					break
				}

				// --- Creation Phase Commands ---
				case OpCodes.CREATE_ENTITY: {
					// Reads the new format with a placeholder ID.
					const placeholderId = reader.readU64()
					if (deletions.has(placeholderId)) {
						break // Don't add to creation list. Loop will advance to next command.
					}
					const archetypeId = reader.readU16()
					const dataSize = reader.readU16()
					const payload = reader.readBuffer(dataSize)
					const trackableIdsCount = reader.readU8()
					const trackableIds = this._trackableIdsBuffer
					trackableIds.length = 0
					for (let j = 0; j < trackableIdsCount; j++) {
						trackableIds.push(reader.readU16())
					}
					creations.varied.push({ placeholderId, archetypeId, payload, trackableIds: [...trackableIds] })
					break
				}
				case OpCodes.CREATE_ENTITIES_IDENTICAL: {
					const count = reader.readU32()
					const archetypeId = reader.readU16()
					const dataSize = reader.readU16()
					const payload = reader.readBuffer(dataSize)
					const trackableIdsCount = reader.readU8()
					const trackableIds = this._trackableIdsBuffer
					trackableIds.length = 0
					for (let j = 0; j < trackableIdsCount; j++) {
						trackableIds.push(reader.readU16())
					}
					creations.identical.push({ count, archetypeId, payload, trackableIds: [...trackableIds] })
					break
				}
			}
		}

		// --- 2. Execution Pass ---
		// Execute consolidated batches in the correct order: Destroy > Modify (real) > Create > Modify (deferred)

		// --- Deletion ---
		this.entityManager.destroyEntitiesInBatch(deletions)

		for (const chunkId of chunkDeletions) {
			this.entityManager.destroyAllEntitiesInChunk(chunkId)
		}

		// --- Modification (on existing entities) ---
		this._buildAndExecuteMoveBatches(modifications, reader, timestampTick)
		this._executeSetDataBatches(modifications.set, reader, timestampTick, true) // Mark dirty
		this._executeSetDataBatches(modifications.setSilent, reader, timestampTick, false) // Do not mark dirty

		// --- Creation & Placeholder Resolution ---
		for (const { placeholderId, archetypeId, payload, trackableIds } of creations.varied) {
			const realEntityId = this.entityManager.createEntityFromAosPayload(archetypeId, payload, timestampTick)
			if (trackableIds.length > 0) {
				// The EntityManager now handles broad-phase dirty marking on creation.
				// The executor is only responsible for the narrow-phase bitmask.
				this.entityMaskManager.markEntitiesDirtyById(realEntityId, trackableIds, timestampTick)
			}
			placeholderResolutionMap.set(placeholderId, realEntityId)
		}

		for (const { count, archetypeId, payload, trackableIds } of creations.identical) {
			const realEntityIds = this.entityManager.createIdenticalEntitiesInArchetype(
				archetypeId,
				payload,
				count,
				timestampTick,
			)
			if (trackableIds.length > 0) {
				for (const realEntityId of realEntityIds) {
					// The EntityManager now handles broad-phase dirty marking on creation.
					// The executor is only responsible for the narrow-phase bitmask.
					this.entityMaskManager.markEntitiesDirtyById(realEntityId, trackableIds, timestampTick)
				}
			}
		}

		// --- Deferred Modifications (on newly created entities) ---
		if (
			deferredModifications.add.length > 0 ||
			deferredModifications.set.length > 0 ||
			deferredModifications.setSilent.length > 0 ||
			deferredModifications.setComponents.length > 0 ||
			deferredModifications.setComponentsSilent.length > 0 ||
			deferredModifications.addComponents.length > 0 ||
			deferredModifications.remove.length > 0
		) {
			this._executeDeferredModifications(deferredModifications, placeholderResolutionMap, reader, timestampTick)
		}

		// Cleanup
		commandBuffer.clear()
	}

	/**
	 * Processes modification commands that were deferred because they targeted placeholder entities.
	 * This runs after creations are complete and all placeholders have been resolved to real entity IDs.
	 * @private
	 */
	_executeDeferredModifications(deferredCommands, resolutionMap, reader, timestampTick) {
		const modifications = this._deferredBatching
		modifications.add.clear()
		modifications.remove.clear()
		modifications.set.clear()
		modifications.setSilent.clear()

		const resolve = id => resolutionMap.get(id) ?? id

		// Unpack and consolidate deferred ADD_COMPONENTS commands
		for (const offset of deferredCommands.addComponents) {
			reader.seek(offset)
			reader.readU8() // Skip OpCode
			const placeholderId = reader.readU64()
			const entityId = resolve(placeholderId)
			if (!entityId) continue // Entity was created and destroyed in the same frame

			const payloadArchetypeId = reader.readU16()
			const dataLength = reader.readU16()
			const payloadDataOffset = reader.offset
			reader.seek(reader.offset + dataLength)
			const trackableIdsCount = reader.readU8()
			const trackableIds = this._trackableIdsBuffer
			trackableIds.length = 0
			for (let j = 0; j < trackableIdsCount; j++) {
				trackableIds.push(reader.readU16())
			}

			const componentIds = this.entityManager.getComponentTypeIDsForArchetype(payloadArchetypeId)

			let componentRelativeOffset = 0
			for (const componentTypeID of componentIds) {
				const info = Schema.componentInfo[componentTypeID]

				// Handle alignment
				const alignment = info.alignment
				if (alignment > 0 && componentRelativeOffset % alignment !== 0) {
					componentRelativeOffset += alignment - (componentRelativeOffset % alignment)
				}

				if (!modifications.add.has(componentTypeID)) {
					modifications.add.set(componentTypeID, [])
				}
				modifications.add.get(componentTypeID).push({
					entityId,
					dataOffset: payloadDataOffset + componentRelativeOffset,
					dataLength: info.byteSize,
					trackableIds: [...trackableIds],
				})
				componentRelativeOffset += info.byteSize
			}
		}

		// Unpack and consolidate deferred SET_COMPONENTS commands
		for (const offset of deferredCommands.setComponents) {
			reader.seek(offset)
			reader.readU8() // Skip OpCode
			const placeholderId = reader.readU64()
			const entityId = resolve(placeholderId)
			if (!entityId) continue // Entity was created and destroyed in the same frame

			const payloadArchetypeId = reader.readU16()
			const dataLength = reader.readU16()
			const payloadDataOffset = reader.offset
			reader.seek(reader.offset + dataLength)
			const trackableIdsCount = reader.readU8()
			const trackableIds = this._trackableIdsBuffer
			trackableIds.length = 0
			for (let j = 0; j < trackableIdsCount; j++) {
				trackableIds.push(reader.readU16())
			}

			const componentIds = this.entityManager.getComponentTypeIDsForArchetype(payloadArchetypeId)

			let componentRelativeOffset = 0
			for (const componentTypeID of componentIds) {
				const info = Schema.componentInfo[componentTypeID]

				// Handle alignment
				const alignment = info.alignment
				if (alignment > 0 && componentRelativeOffset % alignment !== 0) {
					componentRelativeOffset += alignment - (componentRelativeOffset % alignment)
				}

				if (!modifications.set.has(componentTypeID)) {
					modifications.set.set(componentTypeID, [])
				}
				modifications.set.get(componentTypeID).push({
					entityId,
					dataOffset: payloadDataOffset + componentRelativeOffset,
					dataLength: info.byteSize,
					trackableIds: [...trackableIds],
				})
				componentRelativeOffset += info.byteSize
			}
		}

		// Unpack and consolidate deferred SET_COMPONENTS_SILENT commands
		for (const offset of deferredCommands.setComponentsSilent) {
			reader.seek(offset)
			reader.readU8() // Skip OpCode
			const placeholderId = reader.readU64()
			const entityId = resolve(placeholderId)
			if (!entityId) continue

			const payloadArchetypeId = reader.readU16()
			const dataLength = reader.readU16()
			const payloadDataOffset = reader.offset
			reader.seek(reader.offset + dataLength)
			const trackableIdsCount = reader.readU8()
			reader.seek(reader.offset + trackableIdsCount * 2)

			const componentIds = this.entityManager.getComponentTypeIDsForArchetype(payloadArchetypeId)

			let componentRelativeOffset = 0
			for (const componentTypeID of componentIds) {
				const info = Schema.componentInfo[componentTypeID]

				// Handle alignment
				const alignment = info.alignment
				if (alignment > 0 && componentRelativeOffset % alignment !== 0) {
					componentRelativeOffset += alignment - (componentRelativeOffset % alignment)
				}

				if (!modifications.setSilent.has(componentTypeID)) {
					modifications.setSilent.set(componentTypeID, [])
				}
				modifications.setSilent.get(componentTypeID).push({
					entityId,
					dataOffset: payloadDataOffset + componentRelativeOffset,
					dataLength: info.byteSize,
					trackableIds: [],
				})
				componentRelativeOffset += info.byteSize
			}
		}

		// Now, consolidate these resolved commands into batches.
		const processDeferred = (offsets, opCode, batchMap, hasPayload) => {
			for (const offset of offsets) {
				reader.seek(offset)
				reader.readU8() // Skip OpCode
				const entityId = resolve(reader.readU64())
				const componentTypeID = reader.readU16()

				const dataLength = reader.readU16()
				const dataOffset = reader.offset
				reader.seek(reader.offset + dataLength)
				const trackableIdsCount = reader.readU8()
				const trackableIds = this._trackableIdsBuffer
				trackableIds.length = 0
				for (let j = 0; j < trackableIdsCount; j++) {
					trackableIds.push(reader.readU16())
				}

				if (!batchMap.has(componentTypeID)) {
					batchMap.set(componentTypeID, hasPayload ? [] : [])
				}
				const batch = batchMap.get(componentTypeID)

				if (hasPayload) batch.push({ entityId, dataOffset, dataLength, trackableIds: [...trackableIds] })
				else {
					batch.push(entityId)
				}
			}
		}

		processDeferred(deferredCommands.add, OpCodes.ADD_COMPONENT, modifications.add, true)
		processDeferred(deferredCommands.set, OpCodes.SET_COMPONENT, modifications.set, true)
		processDeferred(deferredCommands.setSilent, OpCodes.SET_COMPONENT_SILENT, modifications.setSilent, true)
		processDeferred(deferredCommands.remove, OpCodes.REMOVE_COMPONENT, modifications.remove, false)

		// Finally, execute the now-resolved modification batches.
		this._buildAndExecuteMoveBatches(modifications, reader, timestampTick, resolutionMap)
		this._executeSetDataBatches(modifications.set, reader, timestampTick, true, resolutionMap)
		this._executeSetDataBatches(modifications.setSilent, reader, timestampTick, false, resolutionMap)
	}

	/**
	 * The new, optimized "Gather-and-Blit" function for structural changes.
	 * It gathers all `addComponent` and `removeComponent` commands, groups them by
	 * source chunk and target archetype, and then executes them in batches.
	 * @param {object} modifications The consolidated modification commands.
	 * @param {CommandBufferReader} reader The reader for the raw command buffer.
	 * @param {number} timestampTick The tick to use for timestamping changes.
	 * @private
	 */
	_buildAndExecuteMoveBatches(modifications, reader, timestampTick, resolutionMap = null) {
		// Use pre-allocated maps and clear them for this execution.
		const entityTransitions = this._entityTransitions
		entityTransitions.clear()
		const movesByChunk = this._movesByChunk
		movesByChunk.clear()
		const removalsByArchetype = this._removalsByArchetype
		removalsByArchetype.clear()

		// --- 1. Gather & Consolidate Pass ---
		// First, determine the net structural change for each unique entity.
		// Helper to ensure an entity is in the transition map before processing a modification for it.
		const ensureTransition = entityId => {
			if (!entityTransitions.has(entityId)) {
				const sourceArchetypeId = this.entityManager.getArchetypeForEntity(entityId)
				if (sourceArchetypeId === undefined) return null // Entity might have been destroyed
				const maskOffset = sourceArchetypeId * MASK_PARTS
				const sourceMask = entityStore.archetypeMasks.subarray(maskOffset, maskOffset + MASK_PARTS)
				entityTransitions.set(entityId, {
					sourceArchetypeId,
					targetMask: new BigUint64Array(sourceMask), // Clone the mask
					componentsToAdd: new Map(),
				})
			}
			return entityTransitions.get(entityId)
		}

		// Process Additions
		for (const [componentTypeID, addCommands] of modifications.add.entries()) {
			const partIndex = Math.floor(componentTypeID / 64)
			const bitInPart = 1n << BigInt(componentTypeID % 64)
			for (const cmd of addCommands) {
				const { entityId, dataOffset, dataLength, trackableIds } = cmd
				const transition = ensureTransition(entityId)
				if (!transition) continue

				transition.targetMask[partIndex] |= bitInPart
				transition.componentsToAdd.set(componentTypeID, {
					dataOffset,
					dataLength,
				})
				// Also mark dirty immediately if it's an add, as it's a structural change.
				if (trackableIds.length > 0) this.entityMaskManager.markEntitiesDirtyById(entityId, trackableIds, timestampTick)
			}
		}

		// Process Removals
		for (const [componentTypeID, entityIds] of modifications.remove.entries()) {
			const partIndex = Math.floor(componentTypeID / 64)
			const bitInPart = 1n << BigInt(componentTypeID % 64)
			for (const entityId of entityIds) {
				const transition = ensureTransition(entityId)
				if (!transition) continue
				transition.targetMask[partIndex] &= ~bitInPart
			}
		}

		// --- 2. Build Move Batches ---
		// Group entities by their exact move operation to form compatible batches.
		for (const [entityId, transition] of entityTransitions.entries()) {
			const { sourceArchetypeId, targetMask, componentsToAdd } = transition
			const targetArchetypeId = this.entityManager.getArchetypeByMask(targetMask)

			// If the net change results in no archetype change, skip.
			if (targetArchetypeId === sourceArchetypeId) continue

			const location = this.entityManager.getEntityLocation(entityId)
			if (!location || location.archetypeId !== sourceArchetypeId) continue

			const sourceChunkId = location.chunkId

			if (!movesByChunk.has(sourceChunkId)) movesByChunk.set(sourceChunkId, new Map())
			const chunkMoves = movesByChunk.get(sourceChunkId)

			if (!chunkMoves.has(targetArchetypeId)) {
				chunkMoves.set(targetArchetypeId, {
					entityIds: [],
					sourceLocations: [],
					componentsToAssign: new Map(),
				})
			}
			const moveBatch = chunkMoves.get(targetArchetypeId)

			moveBatch.entityIds.push(entityId)
			moveBatch.sourceLocations.push(location)

			// Populate the component data to be assigned for this entity.
			for (const [typeID, dataInfo] of componentsToAdd.entries()) {
				if (!this.entityManager.hasComponentType(sourceArchetypeId, typeID)) {
					if (!moveBatch.componentsToAssign.has(typeID)) {
						moveBatch.componentsToAssign.set(typeID, { dataOffsets: [], dataLengths: [] })
					}
					const addBatch = moveBatch.componentsToAssign.get(typeID)
					addBatch.dataOffsets.push(dataInfo.dataOffset)
					addBatch.dataLengths.push(dataInfo.dataLength)
				}
			}
		}

		// --- 3. Blit Pass (Execution) ---
		// --- Pass 3a: All Additions & Copies ---
		for (const [sourceChunkId, targets] of movesByChunk.entries()) {
			for (const [targetArchetypeId, moveBatch] of targets.entries()) {
				const { entityIds, sourceLocations, componentsToAssign } = moveBatch
				const sourceArchetypeId = entityStore.chunkArchetypeIds[sourceChunkId]

				// Calculate the bitmasks representing the net change between archetypes.
				const sourceMask = entityStore.archetypeMasks.subarray(
					sourceArchetypeId * MASK_PARTS,
					(sourceArchetypeId + 1) * MASK_PARTS,
				)
				const targetMask = entityStore.archetypeMasks.subarray(
					targetArchetypeId * MASK_PARTS,
					(targetArchetypeId + 1) * MASK_PARTS,
				)
				const addedMask = new BigUint64Array(MASK_PARTS)
				const removedMask = new BigUint64Array(MASK_PARTS)
				for (let i = 0; i < MASK_PARTS; i++) {
					addedMask[i] = targetMask[i] & ~sourceMask[i]
					removedMask[i] = sourceMask[i] & ~targetMask[i]
				}

				this.entityManager._addEntitiesByCopyingBatch(
					// This copies data to the new location
					targetArchetypeId,
					sourceArchetypeId,
					sourceLocations,
					entityIds,
					componentsToAssign,
					reader,
					timestampTick,
					addedMask,
					removedMask,
					resolutionMap,
				)

				// Defer the removal by adding the entities to a final removal batch.
				if (!removalsByArchetype.has(sourceArchetypeId)) removalsByArchetype.set(sourceArchetypeId, [])
				const removalBatch = removalsByArchetype.get(sourceArchetypeId)
				// Instead of just pushing entityIds, we push an object containing the ID and its original location.
				// This prevents a race condition where the entity's location is updated by the copy operation
				// before the removal operation can read the old location.
				for (let i = 0; i < entityIds.length; i++) {
					removalBatch.push({ entityId: entityIds[i], location: sourceLocations[i] })
				}
			}
		}

		// --- Pass 3b: All Removals ---
		// Now that all data has been safely copied, execute the batched removals.
		for (const [sourceArchetypeId, entitiesWithLocations] of removalsByArchetype.entries()) {
			// Call the modified _removeEntitiesBatch with the original locations.
			this.entityManager._removeEntitiesBatch(sourceArchetypeId, entitiesWithLocations)
		}
	}

	_executeSetDataBatches(setDataMap, reader, timestampTick, shouldMarkDirty, resolutionMap = null) {
		for (const [componentTypeID, commands] of setDataMap.entries()) {
			// --- 1. Gather Pass ---
			// First, group all modifications by their destination chunk.
			const setsByChunk = new Map() // Map<chunkId, { destIndices: [], dataOffsets: [], dataLengths: [], trackableCmds: [] }>

			for (const cmd of commands) {
				const { entityId, dataOffset, dataLength, trackableIds } = cmd
				const location = this.entityManager.getEntityLocation(entityId)
				if (!location) continue

				// Developer is responsible for ensuring the entity has the component.
				const chunkId = location.chunkId

				if (!setsByChunk.has(chunkId)) {
					setsByChunk.set(chunkId, { destIndices: [], dataOffsets: [], dataLengths: [], trackableCmds: [] })
				}

				const batch = setsByChunk.get(chunkId)
				batch.destIndices.push(location.indexInChunk)
				batch.dataOffsets.push(dataOffset)
				batch.dataLengths.push(dataLength)
				if (shouldMarkDirty && trackableIds && trackableIds.length > 0) {
					batch.trackableCmds.push({ entityId, trackableIds })
				}
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
					timestampTick,
					shouldMarkDirty,
					resolutionMap,
				)

				for (const { entityId, trackableIds } of batch.trackableCmds) {
					this.entityMaskManager.markEntitiesDirtyById(entityId, trackableIds, timestampTick)
				}
			}
		}
	}
}
