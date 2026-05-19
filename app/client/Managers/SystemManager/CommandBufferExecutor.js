import { CommandBufferReader } from './CommandBufferReader.js'
import { OpCodes } from './CommandOpcodes.js'
import { PlaceholderMap } from './PlaceholderMap.js'
import { SortKeyLayout, SortPhase } from './SortableCommandBuffer.js'
import { MASK_PARTS, entityStore } from '../EntityManager/EntityManager.js'
import { radixSort } from '../../Core/Algorithms/RadixSorter.js'

/**
 * Processes the raw data from an EntityCommandBuffer and applies the structural
 * changes to the EntityManager. This class implements the "Execute" phase of the
 * "Record-Sort-Execute" pipeline.
 */
export class CommandBufferExecutor {
	/**
	 * @param {import('../EntityManager/EntityManager.js').EntityManager} entityManager
	 * @param {import('../EntityMaskManager/EntityMaskManager.js').EntityMaskManager} entityMaskManager
	 */
	constructor(entityManager, entityMaskManager) {
		this.entityManager = entityManager
		this.entityMaskManager = entityMaskManager

		// A custom, array-backed map to avoid allocations during iteration.
		// It's a necessary, temporary structure to resolve placeholder IDs created
		// and referenced within the same frame. It is cleared after every flush.
		this.placeholderResolutionMap = new PlaceholderMap()

		// Reusable readers to avoid allocations in the execute loop.
		this.immediateReader = new CommandBufferReader()
		this.payloadReader = new CommandBufferReader()

		const MOD_SET_DATA_INITIAL_CAPACITY = 32

		// --- Pre-allocated state for the modification pass state machine ---
		this.modAddedComponentsMask = new BigUint64Array(MASK_PARTS)
		this.modRemovedComponentsMask = new BigUint64Array(MASK_PARTS)

		// SoA layout for queued data-setting commands to avoid allocations.
		this.modSetDataCapacity = MOD_SET_DATA_INITIAL_CAPACITY
		this.modSetDataOpCodes = new Uint16Array(MOD_SET_DATA_INITIAL_CAPACITY)
		this.modSetDataPayloadOffsets = new Uint32Array(MOD_SET_DATA_INITIAL_CAPACITY)
		this.modSetDataTypeIds = new Uint16Array(MOD_SET_DATA_INITIAL_CAPACITY)

		// --- Pre-allocated state for the structural consolidation pass ---
		const MOVE_REQUEST_INITIAL_CAPACITY = 128
		this.moveRequestCapacity = MOVE_REQUEST_INITIAL_CAPACITY
		this.moveRequestCount = 0
		// SoA for move requests, enabling efficient sorting and batching.
		this.moveRequestSortKeys = new BigUint64Array(MOVE_REQUEST_INITIAL_CAPACITY)
		this.moveRequestEntityIds = new BigUint64Array(MOVE_REQUEST_INITIAL_CAPACITY)
		this.moveRequestOldPackedLocations = new Uint32Array(MOVE_REQUEST_INITIAL_CAPACITY)
		this.moveRequestOldIndicesInChunk = new Uint32Array(MOVE_REQUEST_INITIAL_CAPACITY)
		this.moveRequestIsSilent = new Uint8Array(MOVE_REQUEST_INITIAL_CAPACITY)
		// Temp buffers for radix sort
		this.tempMoveRequestSortKeys = new BigUint64Array(MOVE_REQUEST_INITIAL_CAPACITY)
		this.tempMoveRequestEntityIds = new BigUint64Array(MOVE_REQUEST_INITIAL_CAPACITY)
		this.tempMoveRequestOldPackedLocations = new Uint32Array(MOVE_REQUEST_INITIAL_CAPACITY)
		this.tempMoveRequestOldIndicesInChunk = new Uint32Array(MOVE_REQUEST_INITIAL_CAPACITY)
		this.tempMoveRequestIsSilent = new Uint8Array(MOVE_REQUEST_INITIAL_CAPACITY)

		this.destroyBatch = []
	}

	_resizeModSetDataCmds() {
		const oldCapacity = this.modSetDataCapacity
		const newCapacity = oldCapacity * 2
		console.warn(
			`[CommandBufferExecutor] Resizing modSetDataCmds buffer from ${oldCapacity} to ${newCapacity}. ` +
				`Consider increasing MOD_SET_DATA_INITIAL_CAPACITY if this happens frequently.`,
		)

		const newOpCodes = new Uint16Array(newCapacity)
		newOpCodes.set(this.modSetDataOpCodes)
		this.modSetDataOpCodes = newOpCodes

		const newOffsets = new Uint32Array(newCapacity)
		newOffsets.set(this.modSetDataPayloadOffsets)
		this.modSetDataPayloadOffsets = newOffsets

		const newTypeIds = new Uint16Array(newCapacity)
		newTypeIds.set(this.modSetDataTypeIds)
		this.modSetDataTypeIds = newTypeIds

		this.modSetDataCapacity = newCapacity
	}

	_resizeMoveRequests() {
		const oldCapacity = this.moveRequestCapacity
		const newCapacity = oldCapacity * 2
		console.warn(
			`[CommandBufferExecutor] Resizing moveRequest buffer from ${oldCapacity} to ${newCapacity}. ` +
				`Consider increasing MOVE_REQUEST_INITIAL_CAPACITY if this happens frequently.`,
		)

		const newSortKeys = new BigUint64Array(newCapacity)
		newSortKeys.set(this.moveRequestSortKeys)
		this.moveRequestSortKeys = newSortKeys

		const newEntityIds = new BigUint64Array(newCapacity)
		newEntityIds.set(this.moveRequestEntityIds)
		this.moveRequestEntityIds = newEntityIds

		const newOldPacked = new Uint32Array(newCapacity)
		newOldPacked.set(this.moveRequestOldPackedLocations)
		this.moveRequestOldPackedLocations = newOldPacked

		const newOldIndices = new Uint32Array(newCapacity)
		newOldIndices.set(this.moveRequestOldIndicesInChunk)
		this.moveRequestOldIndicesInChunk = newOldIndices

		const newIsSilent = new Uint8Array(newCapacity)
		newIsSilent.set(this.moveRequestIsSilent)
		this.moveRequestIsSilent = newIsSilent

		this.tempMoveRequestSortKeys = new BigUint64Array(newCapacity)
		this.tempMoveRequestEntityIds = new BigUint64Array(newCapacity)
		this.tempMoveRequestOldPackedLocations = new Uint32Array(newCapacity)
		this.tempMoveRequestOldIndicesInChunk = new Uint32Array(newCapacity)
		this.tempMoveRequestIsSilent = new Uint8Array(newCapacity)
		this.moveRequestCapacity = newCapacity
	}

	/**
	 * Executes all commands in the provided EntityCommandBuffer.
	 * @param {import('./EntityCommandBuffer.js').EntityCommandBuffer} ecb
	 * @param {number} version
	 */
	execute(ecb, version) {
		// --- 1. Immediate Commands ---
		// These are high-level, pre-compiled bulk operations that bypass the sort.
		// They are executed first to ensure bulk destructions happen before any new
		// creations or modifications are processed, preventing wasted work.
		this._executeImmediateCommands(ecb.immediateCommands, version)

		// --- 2. Sortable Commands ---
		// The main "Record-Sort-Execute" pipeline.
		this._executeSortableCommands(ecb, version)
	}

	/**
	 * A high-level method that executes all commands in a command buffer and then clears it.
	 * This encapsulates the full "execute and reset" cycle for a given buffer.
	 * @param {import('./EntityCommandBuffer.js').EntityCommandBuffer} ecb The command buffer to flush.
	 * @param {number} timestampVersion The version to timestamp the changes with.
	 */
	flush(ecb, timestampVersion) {
		this.execute(ecb, timestampVersion)
		ecb.clear()
	}

	_executeImmediateCommands(immediateBuffer, version) {
		if (immediateBuffer.offset === 0) return

		const reader = this.immediateReader
		reader.setBuffer(immediateBuffer)

		while (reader.offset < immediateBuffer.offset) {
			// The reader's offset is advanced by its read methods.
			const opCode = reader.readU8()

			switch (opCode) {
				case OpCodes.DESTROY_ENTITIES_IN_CHUNK: {
					const chunkId = reader.readU16()
					this.entityManager.destroyEntitiesInChunk(chunkId)
					break
				}
				case OpCodes.DESTROY_BY_QUERY: {
					const queryId = reader.readU32()
					this.entityManager.destroyByQuery(queryId)
					break
				}
				default:
					console.error(`CommandBufferExecutor: Unknown immediate opcode: ${opCode}`)
					return // Avoid an infinite loop on malformed buffer.
			}
		}
	}

	_executeSortableCommands(ecb, version) {
		// 1. Sort the buffer.
		ecb.sortableBuffer.sort()

		const commandCount = ecb.sortableBuffer.size
		if (commandCount === 0) {
			//? clear there might be redundent
			this.placeholderResolutionMap.clear()
			return
		}

		// Get views of the sorted data. These are zero-copy.
		const sortedKeys = ecb.sortableBuffer.getSortedKeys()
		const sortedOffsets = ecb.sortableBuffer.getSortedOffsets()
		const sortedLengths = ecb.sortableBuffer.getSortedLengths()
		const sortedOpCodesAndTypes = ecb.sortableBuffer.getSortedOpCodesAndTypes()
		const sortedGenerations = ecb.sortableBuffer.getSortedGenerations()

		const payloadReader = this.payloadReader
		payloadReader.setBuffer(ecb.frameDataBuffer)

		const firstModifyIndex = this._findFirstIndexOfPhase(sortedKeys, commandCount, SortPhase.MODIFY)
		const firstDestroyIndex = this._findFirstIndexOfPhase(sortedKeys, commandCount, SortPhase.DESTROY)

		// --- Pass 1: Create Entities & Build Placeholder Resolution Map ---
		this._creationAndMappingPass(
			sortedKeys,
			sortedOffsets,
			sortedOpCodesAndTypes,
			firstModifyIndex, // Process up to the first modify command
			payloadReader,
			version,
		)

		// --- Pass 2: Mark any placeholders that are also destroyed in this frame ---
		this._markDestroyedPlaceholdersPass(firstDestroyIndex, sortedKeys, commandCount)

		// --- Pass 3: Structural Consolidation (Read-Only) ---
		// This pass reads all MODIFY commands, calculates the final structural changes
		// for each entity, and populates the `moveRequest` buffers. It does not
		// modify the world state.
		this._structuralConsolidationPass(
			firstModifyIndex,
			firstDestroyIndex,
			sortedKeys,
			sortedOffsets,
			payloadReader,
			sortedOpCodesAndTypes,
			sortedGenerations,
		)

		// --- Pass 4: Structural Execution ---
		// This pass sorts the `moveRequest` buffers and executes the planned structural
		// changes in optimized batches.
		this._structuralExecutionPass(version)

		// --- Pass 5: Data Write ---
		// This pass re-reads the MODIFY commands and applies all data-setting operations
		// (`setComponent`, `addComponents`, etc.) to the entities in their final locations.
		this._dataWritePass(
			firstModifyIndex,
			firstDestroyIndex,
			sortedKeys,
			sortedOffsets,
			sortedOpCodesAndTypes,
			sortedGenerations,
			payloadReader,
			version,
		)

		// --- Pass 6: Final Destruction ---
		this._finalDestructionPass(firstDestroyIndex, sortedKeys, sortedGenerations, commandCount)

		// --- Cleanup ---
		this.moveRequestCount = 0
		this.placeholderResolutionMap.clear()
	}

	_findFirstIndexOfPhase(keys, count, phaseToFind) {
		// A simple linear scan is fine. The array is small enough and this is only done once per flush.
		for (let i = 0; i < count; i++) {
			const key = keys[i]
			const phase = Number((key >> SortKeyLayout.PHASE_SHIFT) & 0xffn)
			if (phase >= phaseToFind) {
				return i
			}
		}
		return count
	}

	_creationAndMappingPass(keys, offsets, opCodesAndTypes, count, payloadReader, version) {
		let i = 0
		for (; i < count; i++) {
			const key = keys[i]
			const phase = Number((key >> SortKeyLayout.PHASE_SHIFT) & 0xffn)

			if (phase > SortPhase.CREATE) {
				// Since the buffer is sorted by phase, we can stop after the last CREATE command.
				break
			}

			const opAndType = opCodesAndTypes[i]
			const opCode = opAndType >> 16

			switch (opCode) {
				case OpCodes.INSTANTIATE: {
					const placeholderStartIndex = Number((key >> SortKeyLayout.ENTITY_INDEX_SHIFT) & 0xffffffffn)

					const archetypeId = opAndType & 0xffff
					const payloadOffset = offsets[i]

					// This is the new unified, high-performance creation path.
					this.entityManager.createEntitiesFromSoaBuffer(
						archetypeId,
						payloadReader,
						payloadOffset,
						version,
						this.placeholderResolutionMap,
						placeholderStartIndex,
					)
					break
				}
				case OpCodes.INSTANTIATE_SILENT: {
					const placeholderStartIndex = Number((key >> SortKeyLayout.ENTITY_INDEX_SHIFT) & 0xffffffffn)

					const archetypeId = opAndType & 0xffff
					const payloadOffset = offsets[i]

					this.entityManager.createEntitiesFromSoaBuffer(
						archetypeId,
						payloadReader,
						payloadOffset,
						version,
						this.placeholderResolutionMap,
						placeholderStartIndex,
						true, // isSilent
					)
					break
				}
			}
		}
		return i
	}

	_markDestroyedPlaceholdersPass(startIndex, keys, count) {
		if (startIndex >= count) return

		for (let i = startIndex; i < count; i++) {
			const key = keys[i]
			// We can assume the phase is DESTROY since we start at the right index.
			const entityIndex = Number((key >> SortKeyLayout.ENTITY_INDEX_SHIFT) & 0xffffffffn)

			const realId = this.placeholderResolutionMap.get(entityIndex)
			if (realId !== 0n) {
				// It's a placeholder. Mark it as destroyed by setting a "doomed" bit (bit 62).
				// We can't use negative numbers as the map uses BigUint64Array.
				this.placeholderResolutionMap.set(entityIndex, realId | (1n << 62n))
			}
		}
	}

	/**
	 * Pass 3: Reads all MODIFY commands, calculates the required structural changes for
	 * each entity, and populates the `moveRequest` buffers for later execution.
	 * This pass is read-only and does not modify the world state.
	 */
	_structuralConsolidationPass(startIndex, endIndex, keys, offsets, payloadReader, opCodesAndTypes, generations) {
		if (startIndex >= endIndex) return

		let currentEntityIndex = -1
		let currentRealEntityId = 0n
		let sourceArchetypeId = -1
		let packedLocation = 0
		let indexInChunk = 0
		let isCurrentEntitySilent = true

		const planStructuralChange = () => {
			let hasStructuralChange = false
			for (let i = 0; i < MASK_PARTS; i++) {
				if (this.modAddedComponentsMask[i] > 0n || this.modRemovedComponentsMask[i] > 0n) {
					hasStructuralChange = true
					break
				}
			}

			if (hasStructuralChange) {
				const targetArchetypeId = this.entityManager.findArchetypeWithChanges(
					sourceArchetypeId,
					this.modAddedComponentsMask,
					this.modRemovedComponentsMask,
				)

				if (targetArchetypeId !== sourceArchetypeId) {
					if (this.moveRequestCount >= this.moveRequestCapacity) {
						this._resizeMoveRequests()
					}

					// The sort key groups by source archetype, then by target archetype.
					// This creates contiguous batches for `moveEntitiesToNewArchetypeInBatch`.
					const sortKey = (BigInt(sourceArchetypeId) << 32n) | BigInt(targetArchetypeId)
					this.moveRequestSortKeys[this.moveRequestCount] = sortKey
					this.moveRequestEntityIds[this.moveRequestCount] = currentRealEntityId
					this.moveRequestOldPackedLocations[this.moveRequestCount] = packedLocation
					this.moveRequestOldIndicesInChunk[this.moveRequestCount] = indexInChunk
					this.moveRequestIsSilent[this.moveRequestCount] = isCurrentEntitySilent ? 1 : 0
					this.moveRequestCount++
				}
			}
		}

		for (let i = startIndex; i < endIndex; i++) {
			const key = keys[i]
			// The sub-key now contains a flag indicating if the command was for a placeholder.
			const subKey = Number(key & SortKeyLayout.SUB_KEY_MASK)
			const isPlaceholderCommand = (subKey >> 15) === 1

			const opAndType = opCodesAndTypes[i]
			const opCode = opAndType >> 16

			// --- NEW: Handle Bulk Commands ---
			// These commands don't fit the per-entity state machine, so we process them
			// with dedicated helpers and continue to the next command.
			if (opCode === OpCodes.BULK_ADD_COMPONENTS) {
				this._processBulkAddComponent(opAndType, offsets[i], payloadReader)
				continue
			}
			if (opCode === OpCodes.BULK_REMOVE_COMPONENTS) {
				this._processBulkRemoveComponent(opAndType, offsets[i], payloadReader)
				continue
			}

			const entityIndex = Number((key >> SortKeyLayout.ENTITY_INDEX_SHIFT) & 0xffffffffn)

			if (entityIndex !== currentEntityIndex) {
				if (currentEntityIndex !== -1) {
					planStructuralChange()
				}

				currentEntityIndex = entityIndex
				this.modAddedComponentsMask.fill(0n)
				this.modRemovedComponentsMask.fill(0n)
				isCurrentEntitySilent = true

				if (isPlaceholderCommand) {
					const realEntityFromPlaceholder = this.placeholderResolutionMap.get(entityIndex)
					if (realEntityFromPlaceholder !== 0n && (realEntityFromPlaceholder & (1n << 62n)) === 0n) {
						currentRealEntityId = realEntityFromPlaceholder
					} else {
						currentRealEntityId = 0n // Mark as invalid to skip processing
						continue
					}
				} else {
					const generation = generations[i]
					currentRealEntityId = (BigInt(generation) << 32n) | BigInt(entityIndex)
				}

				if (!this.entityManager.isEntityActive(currentRealEntityId)) {
					currentRealEntityId = 0n
					continue
				}

				const entityIndexForLocation = Number(currentRealEntityId & 0xffffffffn)
				packedLocation = entityStore.entityPackedLocations[entityIndexForLocation]
				sourceArchetypeId = packedLocation >> 16
				indexInChunk = entityStore.entityIndicesInChunk[entityIndexForLocation]
			}

			if (currentRealEntityId === 0n) continue

			const typeId = opAndType & 0xffff

			switch (opCode) {
				case OpCodes.ADD_COMPONENT: {
					// For ADD_COMPONENT, the componentTypeId is stored in the sub-key
					// (with the placeholder flag in the MSB). We mask out the flag to get the ID.
					const componentTypeId = subKey & 0x7fff
					const partIndex = Math.floor(componentTypeId / 64)
					isCurrentEntitySilent = false
					this.modAddedComponentsMask[partIndex] |= 1n << BigInt(componentTypeId % 64)
					break
				}
				case OpCodes.REMOVE_COMPONENT: {
					const partIndex = Math.floor(typeId / 64)
					isCurrentEntitySilent = false
					this.modRemovedComponentsMask[partIndex] |= 1n << BigInt(typeId % 64)
					break
				}
				case OpCodes.REMOVE_COMPONENTS: {
					const payloadOffset = offsets[i]
					payloadReader.seek(payloadOffset)
					const count = payloadReader.readU16()
					for (let j = 0; j < count; j++) {
						const componentTypeId = payloadReader.readU16()
						const partIndex = Math.floor(componentTypeId / 64)
						isCurrentEntitySilent = false
						this.modRemovedComponentsMask[partIndex] |= 1n << BigInt(componentTypeId % 64)
					}
					break
				}
				case OpCodes.ADD_COMPONENTS: {
					const addedComponentsArchetypeId = opAndType & 0xffff
					const addedComponentsMaskOffset = addedComponentsArchetypeId * MASK_PARTS
					for (let k = 0; k < MASK_PARTS; k++) {
						isCurrentEntitySilent = false
						this.modAddedComponentsMask[k] |= entityStore.archetypeMasks[addedComponentsMaskOffset + k]
					}
					break
				}
				case OpCodes.ADD_COMPONENT_SILENT: {
					const componentTypeId = subKey & 0x7fff
					const partIndex = Math.floor(componentTypeId / 64)
					this.modAddedComponentsMask[partIndex] |= 1n << BigInt(componentTypeId % 64)
					break
				}
				case OpCodes.ADD_COMPONENTS_SILENT: {
					const addedComponentsArchetypeId = opAndType & 0xffff
					const addedComponentsMaskOffset = addedComponentsArchetypeId * MASK_PARTS
					for (let k = 0; k < MASK_PARTS; k++) {
						this.modAddedComponentsMask[k] |= entityStore.archetypeMasks[addedComponentsMaskOffset + k]
					}
					break
				}
			}
		}

		if (currentEntityIndex !== -1) {
			planStructuralChange()
		}
	}

	_processBulkAddComponent(opAndType, payloadOffset, reader) {
		reader.seek(payloadOffset)
		const entityCount = reader.readU32()

		// Get the mask for the components being added.
		const addedComponentsArchetypeId = opAndType & 0xffff
		const addedMask = new BigUint64Array(MASK_PARTS) // This is a temporary, stack-allocated view.
		const addedComponentsMaskOffset = addedComponentsArchetypeId * MASK_PARTS
		for (let k = 0; k < MASK_PARTS; k++) {
			addedMask[k] = entityStore.archetypeMasks[addedComponentsMaskOffset + k]
		}

		for (let j = 0; j < entityCount; j++) {
			const entityId = reader.readU64()

			if (!this.entityManager.isEntityActive(entityId)) continue

			const entityIndex = Number(entityId & 0xffffffffn)
			const packedLocation = entityStore.entityPackedLocations[entityIndex]
			const sourceArchetypeId = packedLocation >> 16
			const indexInChunk = entityStore.entityIndicesInChunk[entityIndex]

			// Calculate target archetype
			const sourceMaskOffset = sourceArchetypeId * MASK_PARTS
			const targetMask = this.modAddedComponentsMask // Reuse a scratch buffer
			for (let k = 0; k < MASK_PARTS; k++) {
				targetMask[k] = entityStore.archetypeMasks[sourceMaskOffset + k] | addedMask[k]
			}
			const targetArchetypeId = this.entityManager.getArchetypeByMask(targetMask)

			if (targetArchetypeId !== sourceArchetypeId) {
				if (this.moveRequestCount >= this.moveRequestCapacity) {
					this._resizeMoveRequests()
				}
				const sortKey = (BigInt(sourceArchetypeId) << 32n) | BigInt(targetArchetypeId)
				this.moveRequestSortKeys[this.moveRequestCount] = sortKey
				this.moveRequestEntityIds[this.moveRequestCount] = entityId
				this.moveRequestOldPackedLocations[this.moveRequestCount] = packedLocation
				this.moveRequestOldIndicesInChunk[this.moveRequestCount] = indexInChunk
				this.moveRequestCount++
			}
		}
	}

	_processBulkRemoveComponent(opAndType, payloadOffset, reader) {
		reader.seek(payloadOffset)
		const entityCount = reader.readU32()
		const componentIdCount = reader.readU16()

		const removedMask = this.modRemovedComponentsMask // Reuse scratch
		removedMask.fill(0n)
		for (let i = 0; i < componentIdCount; i++) {
			const componentTypeId = reader.readU16()
			const partIndex = Math.floor(componentTypeId / 64)
			removedMask[partIndex] |= 1n << BigInt(componentTypeId % 64)
		}

		for (let j = 0; j < entityCount; j++) {
			const entityId = reader.readU64()
			if (!this.entityManager.isEntityActive(entityId)) continue

			const entityIndex = Number(entityId & 0xffffffffn)
			const packedLocation = entityStore.entityPackedLocations[entityIndex]
			const sourceArchetypeId = packedLocation >> 16
			const indexInChunk = entityStore.entityIndicesInChunk[entityIndex]

			const sourceMaskOffset = sourceArchetypeId * MASK_PARTS
			const targetMask = this.modAddedComponentsMask // Reuse another scratch
			for (let k = 0; k < MASK_PARTS; k++) {
				targetMask[k] = entityStore.archetypeMasks[sourceMaskOffset + k] & ~removedMask[k]
			}
			const targetArchetypeId = this.entityManager.getArchetypeByMask(targetMask)

			if (targetArchetypeId !== sourceArchetypeId) {
				if (this.moveRequestCount >= this.moveRequestCapacity) {
					this._resizeMoveRequests()
				}
				const sortKey = (BigInt(sourceArchetypeId) << 32n) | BigInt(targetArchetypeId)
				this.moveRequestSortKeys[this.moveRequestCount] = sortKey
				this.moveRequestEntityIds[this.moveRequestCount] = entityId
				this.moveRequestOldPackedLocations[this.moveRequestCount] = packedLocation
				this.moveRequestOldIndicesInChunk[this.moveRequestCount] = indexInChunk
				this.moveRequestCount++
			}
		}
	}

	/**
	 * Pass 4: Sorts the `moveRequest` buffers and executes the planned structural
	 * changes in optimized batches.
	 */
	_structuralExecutionPass(version) {
		if (this.moveRequestCount === 0) return

		const count = this.moveRequestCount

		// 1. Sort all move requests to group them by source/target archetype.
		radixSort(
			this.moveRequestSortKeys.subarray(0, count),
			this.moveRequestEntityIds.subarray(0, count),
			this.moveRequestOldPackedLocations.subarray(0, count),
			this.moveRequestOldIndicesInChunk.subarray(0, count),
			this.moveRequestIsSilent.subarray(0, count),
			this.tempMoveRequestSortKeys.subarray(0, count),
			this.tempMoveRequestEntityIds.subarray(0, count),
			this.tempMoveRequestOldPackedLocations.subarray(0, count),
			this.tempMoveRequestOldIndicesInChunk.subarray(0, count),
			this.tempMoveRequestIsSilent.subarray(0, count),
		)

		// 2. Iterate through the sorted requests and execute them in batches.
		let i = 0
		while (i < count) {
			const sortKey = this.moveRequestSortKeys[i]
			const sourceArchetypeId = Number(sortKey >> 32n)
			const targetArchetypeId = Number(sortKey & 0xffffffffn)

			// Find the end of the current batch.
			let batchEnd = i + 1
			while (batchEnd < count && this.moveRequestSortKeys[batchEnd] === sortKey) {
				batchEnd++
			}
			const batchSize = batchEnd - i

			// Execute the batch move. This method will populate the new location map.
			this.entityManager.moveEntitiesToNewArchetypeInBatch(
				sourceArchetypeId,
				targetArchetypeId,
				this.moveRequestEntityIds.subarray(i, batchEnd), // Pass subarray view
				this.moveRequestOldPackedLocations.subarray(i, batchEnd), // Pass subarray view
				this.moveRequestOldIndicesInChunk.subarray(i, batchEnd), // Pass subarray view
				batchSize,
				version,
				this.moveRequestIsSilent.subarray(i, batchEnd),
			)

			i = batchEnd
		}
	}

	/**
	 * Pass 5: Re-reads all MODIFY commands and applies all data-setting operations
	 * to the entities in their final, post-move locations.
	 */
	_dataWritePass(startIndex, endIndex, keys, offsets, opCodesAndTypes, generations, payloadReader, version) {
		if (startIndex >= endIndex) return

		for (let i = startIndex; i < endIndex; i++) {
			const key = keys[i]
			const subKey = Number(key & SortKeyLayout.SUB_KEY_MASK)
			const isPlaceholderCommand = (subKey >> 15) === 1

			const opAndType = opCodesAndTypes[i]
			const opCode = opAndType >> 16
			const payloadOffset = offsets[i]

			if (opCode === OpCodes.BULK_ADD_COMPONENTS) {
				this._processBulkDataWrite(opAndType, payloadOffset, payloadReader, version)
				continue
			}

			const placeholderOrEntityIndex = Number((key >> SortKeyLayout.ENTITY_INDEX_SHIFT) & 0xffffffffn)

			let realEntityId
			if (isPlaceholderCommand) {
				const realEntityFromPlaceholder = this.placeholderResolutionMap.get(placeholderOrEntityIndex)
				// Check if it was resolved and not "doomed"
				if (realEntityFromPlaceholder !== 0n && (realEntityFromPlaceholder & (1n << 62n)) === 0n) {
					realEntityId = realEntityFromPlaceholder
				} else {
					continue // Skip this command, placeholder was destroyed or never existed.
				}
			} else {
				const generation = generations[i]
				realEntityId = (BigInt(generation) << 32n) | BigInt(placeholderOrEntityIndex)
			}

			if (!this.entityManager.isEntityActive(realEntityId)) continue

			const typeId = opAndType & 0xffff

			// The _structuralExecutionPass has already updated the entityStore with the
			// final locations for all entities. We can read directly from the source of truth.
			const realEntityIndex = Number(realEntityId & 0xffffffffn)
			const finalPackedLocation = entityStore.entityPackedLocations[realEntityIndex]
			if (finalPackedLocation === 0) continue // Entity is not in a chunk (inactive or destroyed).
			const finalChunkId = finalPackedLocation & 0xffff
			const finalIndexInChunk = entityStore.entityIndicesInChunk[realEntityIndex]

			if (finalChunkId === 0) continue // Should not happen for an active entity.

			switch (opCode) {
				case OpCodes.ADD_COMPONENT: {
					this.entityManager._setComponentsDataFromSoaBufferAtLocation(
						finalChunkId,
						finalIndexInChunk,
						realEntityId,
						typeId,
						payloadReader,
						payloadOffset,
						this.placeholderResolutionMap,
						version,
						false,
						true, // isAddComponent
					)
					break
				}
				case OpCodes.ADD_COMPONENTS:
				case OpCodes.SET_COMPONENTS: {
					this.entityManager._setComponentsDataFromSoaBufferAtLocation(
						finalChunkId,
						finalIndexInChunk,
						realEntityId,
						typeId,
						payloadReader,
						payloadOffset,
						this.placeholderResolutionMap,
						version,
						false,
						opCode === OpCodes.ADD_COMPONENTS,
					)
					break
				}
				case OpCodes.SET_COMPONENTS_SILENT: {
					this.entityManager._setComponentsDataFromSoaBufferAtLocation(
						finalChunkId,
						finalIndexInChunk,
						realEntityId,
						typeId,
						payloadReader,
						payloadOffset,
						this.placeholderResolutionMap,
						version,
						true,
					)
					break
				}
				case OpCodes.ADD_COMPONENT_SILENT:
				case OpCodes.ADD_COMPONENTS_SILENT: {
					this.entityManager._setComponentsDataFromSoaBufferAtLocation(
						finalChunkId,
						finalIndexInChunk,
						realEntityId,
						typeId,
						payloadReader,
						payloadOffset,
						this.placeholderResolutionMap,
						version,
						true, // isSilent
						true, // isAddComponent
					)
					break
				}
			}
		}
	}

	_processBulkDataWrite(opAndType, payloadOffset, reader, version) {
		reader.seek(payloadOffset)
		const entityCount = reader.readU32()
		if (entityCount === 0) return

		// The entity IDs are written first in the payload.
		const entityIdsOffset = reader.offset
		// The component data payload starts after the list of entity IDs.
		const componentPayloadOffset = entityIdsOffset + entityCount * 8 // 8 bytes per bigint

		const archetypeId = opAndType & 0xffff

		for (let i = 0; i < entityCount; i++) {
			// Read entityId from the list in the payload
			const entityIdFromPayload = reader.view.getBigUint64(entityIdsOffset + i * 8, true)

			// Resolve placeholder if necessary
			let realEntityId
			const isPlaceholder = entityIdFromPayload >> 63n === 1n
			if (isPlaceholder) {
				const placeholderIndex = Number(entityIdFromPayload & 0xffffffffn)
				const resolvedId = this.placeholderResolutionMap.get(placeholderIndex)
				if (resolvedId === 0n || (resolvedId & (1n << 62n)) !== 0n) {
					continue // Entity was never created or was destroyed
				}
				realEntityId = resolvedId
			} else {
				realEntityId = entityIdFromPayload
			}

			if (!this.entityManager.isEntityActive(realEntityId)) continue

			// Get final location
			const realEntityIndex = Number(realEntityId & 0xffffffffn)
			const finalPackedLocation = entityStore.entityPackedLocations[realEntityIndex]
			if (finalPackedLocation === 0) continue
			const finalChunkId = finalPackedLocation & 0xffff
			const finalIndexInChunk = entityStore.entityIndicesInChunk[realEntityIndex]

			// Apply data
			this.entityManager._setComponentsDataFromSoaBufferAtLocation(
				finalChunkId,
				finalIndexInChunk,
				realEntityId,
				archetypeId,
				reader,
				componentPayloadOffset,
				this.placeholderResolutionMap,
				version,
				false,
			)
		}
	}

	_finalDestructionPass(startIndex, keys, generations, count) {
		if (startIndex >= count) return

		this.destroyBatch.length = 0

		for (let i = startIndex; i < count; i++) {
			const key = keys[i]
			const phase = Number((key >> SortKeyLayout.PHASE_SHIFT) & 0xffn)

			// This pass only handles destroy commands.
			if (phase < SortPhase.DESTROY) continue

			const entityIndex = Number((key >> SortKeyLayout.ENTITY_INDEX_SHIFT) & 0xffffffffn)
			const generation = generations[i]

			// Check if this is a placeholder being destroyed.
			const resolvedId = this.placeholderResolutionMap.get(entityIndex)

			if (resolvedId !== 0n) {
				// This was a placeholder. The "doomed" bit might be set.
				// We must strip the doomed bit to get the real ID to destroy.

				const realEntityIdToDestroy = resolvedId & ~(1n << 62n)
				this.destroyBatch.push(realEntityIdToDestroy)
			} else {
				// This is a real entity.
				const realEntityId = (BigInt(generation) << 32n) | BigInt(entityIndex)
				if (this.entityManager.isEntityActive(realEntityId)) {
					this.destroyBatch.push(realEntityId)
				}
			}
		}

		if (this.destroyBatch.length > 0) {
			this.entityManager.destroyEntitiesInBatch(this.destroyBatch, this.destroyBatch.length)
		}
	}
}
