import { OpCodes } from './CommandOpcodes.js'
import { CommandBufferReader } from './CommandBufferReader.js'
import * as Schema from '../ComponentManager/ComponentSchema.js'
import { entityStore, MASK_PARTS } from '../EntityManager/EntityManager.js'

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
		this._currentCommandBuffer = null
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
		const creations = {
			identical: [],
			// varied is now an array of { placeholderId, archetypeId, payload }
			varied: [],
		}
		const modifications = {
			// This now stores binary payload modification commands
			add: new Map(), // Map<componentTypeID, { entityIds: number[], dataOffsets: number[], dataLengths: number[] }>
			remove: new Map(), // Map<componentTypeID, bigint[]>
			set: new Map(), // Map<componentTypeID, { entityIds: number[], soaIndices: number[] }>
			setSilent: new Map(), // For SET_COMPONENT_DATA_SILENT
			setEnabled: new Map(), // Map<componentTypeID, { entityIds: bigint[], states: number[] }>,
			markDirty: new Map(), // Map<componentTypeID, { entityIds: bigint[], ticks: number[] }>
		}
		const deferredModifications = {
			add: [],
			set: [],
			remove: [],
			addComponents: [],
			setComponents: [],
			setComponentsSilent: [],
			setEnabled: [],
			markDirty: [],
		}
		const placeholderResolutionMap = new Map()
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
					if ((entityId >> 63n) === 1n) {
						// Defer modifications on placeholder entities
						deferredModifications.add.push(sortedOffsets[i])
						continue
					}
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
				case OpCodes.ADD_COMPONENTS: {
					const entityId = reader.readU64()
					if ((entityId >> 63n) === 1n) {
						// Defer modifications on placeholder entities
						deferredModifications.addComponents.push(sortedOffsets[i])
						continue
					}
					if (deletions.has(entityId)) continue // Skip mods on deleted entities

					const payloadArchetypeId = reader.readU16()
					reader.readU16() // Skip dataLength
					const payloadDataOffset = reader.offset // The offset where the AoS binary data starts

					const componentIds = this.entityManager.getComponentTypeIDsForArchetype(payloadArchetypeId)
					if (!componentIds) continue

					let componentRelativeOffset = 0
					for (const componentTypeID of componentIds) {
						const info = Schema.componentInfo[componentTypeID]
						if (!info) continue

						// Handle alignment within the AoS payload
						const alignment = info.alignment
						if (alignment > 0 && componentRelativeOffset % alignment !== 0) {
							componentRelativeOffset += alignment - (componentRelativeOffset % alignment)
						}

						if (!modifications.add.has(componentTypeID)) {
							modifications.add.set(componentTypeID, { entityIds: [], dataOffsets: [], dataLengths: [] })
						}
						const addBatch = modifications.add.get(componentTypeID)
						addBatch.entityIds.push(entityId)
						addBatch.dataOffsets.push(payloadDataOffset + componentRelativeOffset)
						addBatch.dataLengths.push(info.byteSize)
						componentRelativeOffset += info.byteSize
					}
					break
				}
				case OpCodes.SET_COMPONENTS_DATA: {
					const entityId = reader.readU64()
					if ((entityId >> 63n) === 1n) {
						// Defer modifications on placeholder entities
						deferredModifications.setComponents.push(sortedOffsets[i])
						continue
					}
					if (deletions.has(entityId)) continue // Skip mods on deleted entities

					const payloadArchetypeId = reader.readU16()
					reader.readU16() // Skip dataLength
					const payloadDataOffset = reader.offset // The offset where the AoS binary data starts

					const componentIds = this.entityManager.getComponentTypeIDsForArchetype(payloadArchetypeId)
					if (!componentIds) continue

					let componentRelativeOffset = 0
					for (const componentTypeID of componentIds) {
						const info = Schema.componentInfo[componentTypeID]
						if (!info) continue

						// Handle alignment within the AoS payload
						const alignment = info.alignment
						if (alignment > 0 && componentRelativeOffset % alignment !== 0) {
							componentRelativeOffset += alignment - (componentRelativeOffset % alignment)
						}

						if (!modifications.set.has(componentTypeID)) {
							modifications.set.set(componentTypeID, { entityIds: [], dataOffsets: [], dataLengths: [] })
						}
						const setBatch = modifications.set.get(componentTypeID)
						setBatch.entityIds.push(entityId)
						setBatch.dataOffsets.push(payloadDataOffset + componentRelativeOffset)
						setBatch.dataLengths.push(info.byteSize)
						componentRelativeOffset += info.byteSize
					}
					break
				}
				case OpCodes.SET_COMPONENTS_DATA_SILENT: {
					const entityId = reader.readU64()
					if ((entityId >> 63n) === 1n) {
						// Defer modifications on placeholder entities
						deferredModifications.setComponentsSilent.push(sortedOffsets[i])
						continue
					}
					if (deletions.has(entityId)) continue // Skip mods on deleted entities

					const payloadArchetypeId = reader.readU16()
					reader.readU16() // Skip dataLength
					const payloadDataOffset = reader.offset

					const componentIds = this.entityManager.getComponentTypeIDsForArchetype(payloadArchetypeId)
					if (!componentIds) continue

					let componentRelativeOffset = 0
					for (const componentTypeID of componentIds) {
						const info = Schema.componentInfo[componentTypeID]
						if (!info) continue

						// Handle alignment within the AoS payload
						const alignment = info.alignment
						if (alignment > 0 && componentRelativeOffset % alignment !== 0) {
							componentRelativeOffset += alignment - (componentRelativeOffset % alignment)
						}

						if (!modifications.setSilent.has(componentTypeID)) {
							modifications.setSilent.set(componentTypeID, { entityIds: [], dataOffsets: [], dataLengths: [] })
						}
						const setBatch = modifications.setSilent.get(componentTypeID)
						setBatch.entityIds.push(entityId)
						setBatch.dataOffsets.push(payloadDataOffset + componentRelativeOffset)
						setBatch.dataLengths.push(info.byteSize)
						componentRelativeOffset += info.byteSize
					}
					break
				}
				case OpCodes.REMOVE_COMPONENT: {
					const entityId = reader.readU64()
					if ((entityId >> 63n) === 1n) {
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
				case OpCodes.SET_COMPONENT_DATA: {
					const entityId = reader.readU64()
					if ((entityId >> 63n) === 1n) {
						// Defer modifications on placeholder entities
						deferredModifications.set.push(sortedOffsets[i])
						continue
					}
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

				case OpCodes.SET_COMPONENT_DATA_SILENT: {
					const entityId = reader.readU64()
					if ((entityId >> 63n) === 1n) {
						// Defer modifications on placeholder entities
						deferredModifications.set.push(sortedOffsets[i]) // Can reuse the 'set' deferred array
						continue
					}
					if (deletions.has(entityId)) continue
					const componentTypeID = reader.readU16()
					const dataLength = reader.readU16()
					const dataOffset = reader.offset

					if (!modifications.setSilent.has(componentTypeID)) {
						modifications.setSilent.set(componentTypeID, { entityIds: [], dataOffsets: [], dataLengths: [] })
					}
					const setBatch = modifications.setSilent.get(componentTypeID)
					setBatch.entityIds.push(entityId)
					setBatch.dataOffsets.push(dataOffset)
					setBatch.dataLengths.push(dataLength)
					break
				}

				case OpCodes.SET_COMPONENT_ENABLED: {
					const entityId = reader.readU64()
					if ((entityId >> 63n) === 1n) {
						deferredModifications.setEnabled.push(sortedOffsets[i])
						continue
					}
					if (deletions.has(entityId)) continue
					const componentTypeID = reader.readU16()
					const enabledState = reader.readU8()

					if (!modifications.setEnabled.has(componentTypeID)) {
						modifications.setEnabled.set(componentTypeID, { entityIds: [], states: [] })
					}
					const setEnabledBatch = modifications.setEnabled.get(componentTypeID)
					setEnabledBatch.entityIds.push(entityId)
					setEnabledBatch.states.push(enabledState)
					break
				}

				case OpCodes.MARK_DIRTY: {
					const entityId = reader.readU64()
					if ((entityId >> 63n) === 1n) {
						deferredModifications.markDirty.push(sortedOffsets[i])
						continue
					}
					if (deletions.has(entityId)) continue
					const componentTypeID = reader.readU16()
					const tick = reader.readU32()

					if (!modifications.markDirty.has(componentTypeID)) {
						modifications.markDirty.set(componentTypeID, { entityIds: [], ticks: [] })
					}
					const markDirtyBatch = modifications.markDirty.get(componentTypeID)
					markDirtyBatch.entityIds.push(entityId)
					markDirtyBatch.ticks.push(tick)
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
					creations.varied.push({ placeholderId, archetypeId, payload })
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
		// Execute consolidated batches in the correct order: Destroy > Modify (real) > Create > Modify (deferred)

		// --- Deletion ---
		this.entityManager.destroyEntitiesInBatch(deletions)

		for (const chunkId of chunkDeletions) {
			this.entityManager.destroyAllEntitiesInChunk(chunkId)
		}

		// --- Modification (on existing entities) ---
		this._buildAndExecuteMoveBatches(modifications, reader, currentTick)
		this._executeSetDataBatches(modifications.set, reader, currentTick, true) // Mark dirty
		this._executeSetDataBatches(modifications.setSilent, reader, currentTick, false) // Do not mark dirty
		this._executeSetEnabledBatches(modifications.setEnabled)
		this._executeMarkDirtyBatches(modifications.markDirty)

		// --- Creation & Placeholder Resolution ---
		for (const { placeholderId, archetypeId, payload } of creations.varied) {
			const realEntityId = this.entityManager.createEntityFromAosPayload(archetypeId, payload, currentTick)
			placeholderResolutionMap.set(placeholderId, realEntityId)
		}

		for (const { count, archetypeId, payload } of creations.identical) {
			this.entityManager.createIdenticalEntitiesInArchetype(archetypeId, payload, count, currentTick)
		}

		// --- Deferred Modifications (on newly created entities) ---
		if (
			deferredModifications.add.length > 0 ||
			deferredModifications.set.length > 0 ||
			deferredModifications.setComponents.length > 0 ||
			deferredModifications.setComponentsSilent.length > 0 ||
			deferredModifications.addComponents.length > 0 ||
			deferredModifications.remove.length > 0 ||
			deferredModifications.setEnabled.length > 0 ||
			deferredModifications.markDirty.length > 0
		) {
			this._executeDeferredModifications(deferredModifications, placeholderResolutionMap, reader, currentTick)
		}

		// Cleanup
		commandBuffer.clear()
		this._currentCommandBuffer = null
	}

	/**
	 * Processes modification commands that were deferred because they targeted placeholder entities.
	 * This runs after creations are complete and all placeholders have been resolved to real entity IDs.
	 * @private
	 */
	_executeDeferredModifications(deferredCommands, resolutionMap, reader, currentTick) {
		const modifications = {
			add: new Map(),
			remove: new Map(),
			set: new Map(),
			setSilent: new Map(),
			// No setComponents here, they are unpacked directly into .set/.setSilent
			addComponents: [],
			setEnabled: new Map(),
			markDirty: new Map(),
		}
		const resolve = id => resolutionMap.get(id) ?? id

		// In-place patch payloads in the command buffer to resolve nested placeholders.
		// This is safe because the command buffer is cleared after execution.
		for (const offset of deferredCommands.add) {
			this._patchCommandPayload(offset, OpCodes.ADD_COMPONENT, resolutionMap, reader)
		}
		for (const offset of deferredCommands.set) {
			this._patchCommandPayload(offset, OpCodes.SET_COMPONENT_DATA, resolutionMap, reader)
		}

		// Unpack and consolidate deferred ADD_COMPONENTS commands
		for (const offset of deferredCommands.addComponents) {
			reader.seek(offset)
			reader.readU8() // Skip OpCode
			const placeholderId = reader.readU64()
			const entityId = resolve(placeholderId)
			if (!entityId) continue // Entity was created and destroyed in the same frame

			const payloadArchetypeId = reader.readU16()
			reader.readU16() // Skip dataLength
			const payloadDataOffset = reader.offset

			const componentIds = this.entityManager.getComponentTypeIDsForArchetype(payloadArchetypeId)
			if (!componentIds) continue

			let componentRelativeOffset = 0
			for (const componentTypeID of componentIds) {
				const info = Schema.componentInfo[componentTypeID]
				if (!info) continue

				// Handle alignment
				const alignment = info.alignment
				if (alignment > 0 && componentRelativeOffset % alignment !== 0) {
					componentRelativeOffset += alignment - (componentRelativeOffset % alignment)
				}

				if (!modifications.add.has(componentTypeID)) {
					modifications.add.set(componentTypeID, { entityIds: [], dataOffsets: [], dataLengths: [] })
				}
				const addBatch = modifications.add.get(componentTypeID)
				addBatch.entityIds.push(entityId)
				addBatch.dataOffsets.push(payloadDataOffset + componentRelativeOffset)
				addBatch.dataLengths.push(info.byteSize)

				componentRelativeOffset += info.byteSize
			}
		}

		// Unpack and consolidate deferred SET_COMPONENTS_DATA commands
		for (const offset of deferredCommands.setComponents) {
			reader.seek(offset)
			reader.readU8() // Skip OpCode
			const placeholderId = reader.readU64()
			const entityId = resolve(placeholderId)
			if (!entityId) continue // Entity was created and destroyed in the same frame

			const payloadArchetypeId = reader.readU16()
			reader.readU16() // Skip dataLength
			const payloadDataOffset = reader.offset

			const componentIds = this.entityManager.getComponentTypeIDsForArchetype(payloadArchetypeId)
			if (!componentIds) continue

			let componentRelativeOffset = 0
			for (const componentTypeID of componentIds) {
				const info = Schema.componentInfo[componentTypeID]
				if (!info) continue

				// Handle alignment
				const alignment = info.alignment
				if (alignment > 0 && componentRelativeOffset % alignment !== 0) {
					componentRelativeOffset += alignment - (componentRelativeOffset % alignment)
				}

				if (!modifications.set.has(componentTypeID)) {
					modifications.set.set(componentTypeID, { entityIds: [], dataOffsets: [], dataLengths: [] })
				}
				const setBatch = modifications.set.get(componentTypeID)
				setBatch.entityIds.push(entityId)
				setBatch.dataOffsets.push(payloadDataOffset + componentRelativeOffset)
				setBatch.dataLengths.push(info.byteSize)

				componentRelativeOffset += info.byteSize
			}
		}

		// Unpack and consolidate deferred SET_COMPONENTS_DATA_SILENT commands
		for (const offset of deferredCommands.setComponentsSilent) {
			reader.seek(offset)
			reader.readU8() // Skip OpCode
			const placeholderId = reader.readU64()
			const entityId = resolve(placeholderId)
			if (!entityId) continue

			const payloadArchetypeId = reader.readU16()
			reader.readU16() // Skip dataLength
			const payloadDataOffset = reader.offset

			const componentIds = this.entityManager.getComponentTypeIDsForArchetype(payloadArchetypeId)
			if (!componentIds) continue

			let componentRelativeOffset = 0
			for (const componentTypeID of componentIds) {
				const info = Schema.componentInfo[componentTypeID]
				if (!info) continue

				// Handle alignment
				const alignment = info.alignment
				if (alignment > 0 && componentRelativeOffset % alignment !== 0) {
					componentRelativeOffset += alignment - (componentRelativeOffset % alignment)
				}

				if (!modifications.setSilent.has(componentTypeID)) {
					modifications.setSilent.set(componentTypeID, { entityIds: [], dataOffsets: [], dataLengths: [] })
				}
				const setBatch = modifications.setSilent.get(componentTypeID)
				setBatch.entityIds.push(entityId)
				setBatch.dataOffsets.push(payloadDataOffset + componentRelativeOffset)
				setBatch.dataLengths.push(info.byteSize)

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

				if (!batchMap.has(componentTypeID)) {
					batchMap.set(componentTypeID, hasPayload ? { entityIds: [], dataOffsets: [], dataLengths: [] } : [])
				}
				const batch = batchMap.get(componentTypeID)

				if (hasPayload) {
					const dataLength = reader.readU16()
					const dataOffset = reader.offset
					batch.entityIds.push(entityId)
					batch.dataOffsets.push(dataOffset)
					batch.dataLengths.push(dataLength)
				} else {
					batch.push(entityId)
				}
			}
		}

		processDeferred(deferredCommands.add, OpCodes.ADD_COMPONENT, modifications.add, true)
		processDeferred(deferredCommands.set, OpCodes.SET_COMPONENT_DATA, modifications.set, true)
		processDeferred(deferredCommands.remove, OpCodes.REMOVE_COMPONENT, modifications.remove, false)

		// Note: We don't need a separate deferred path for setSilent. If a silent set is deferred,
		// it's because it's on a new entity. New entities are already marked dirty on creation,
		// so treating a deferred silent set as a normal set is acceptable and simpler.
		for (const offset of deferredCommands.setEnabled) {
			reader.seek(offset)
			reader.readU8() // Skip OpCode
			const entityId = resolve(reader.readU64())
			const componentTypeID = reader.readU16()
			const enabledState = reader.readU8()

			if (!modifications.setEnabled.has(componentTypeID)) {
				modifications.setEnabled.set(componentTypeID, { entityIds: [], states: [] })
			}
			const batch = modifications.setEnabled.get(componentTypeID)
			batch.entityIds.push(entityId)
			batch.states.push(enabledState)
		}

		for (const offset of deferredCommands.markDirty) {
			reader.seek(offset)
			reader.readU8() // Skip OpCode
			const entityId = resolve(reader.readU64())
			const componentTypeID = reader.readU16()
			const tick = reader.readU32()

			if (!modifications.markDirty.has(componentTypeID)) {
				modifications.markDirty.set(componentTypeID, { entityIds: [], ticks: [] })
			}
			const batch = modifications.markDirty.get(componentTypeID)
			batch.entityIds.push(entityId)
			batch.ticks.push(tick)
		}

		// Finally, execute the now-resolved modification batches.
		this._buildAndExecuteMoveBatches(modifications, reader, currentTick)
		this._executeSetDataBatches(modifications.set, reader, currentTick, true)
		this._executeSetDataBatches(modifications.setSilent, reader, currentTick, false)
		this._executeSetEnabledBatches(modifications.setEnabled)
		this._executeMarkDirtyBatches(modifications.markDirty)
	}

	/**
	 * Finds and replaces placeholder entity IDs within a command's binary payload.
	 * This modifies the raw command buffer in-place.
	 * @private
	 */
	_patchCommandPayload(offset, opCode, resolutionMap, reader) {
		reader.seek(offset)
		reader.readU8() // OpCode
		reader.readU64() // EntityId
		const componentTypeID = reader.readU16()
		const info = Schema.componentInfo[componentTypeID]
		if (!info) return

		const view = new DataView(reader.buffer)
		for (const propKey of info.propertyKeys) {
			const propInfo = info.properties[propKey]
			// Only patch properties explicitly defined as 'entity' type.
			if (propInfo.type === 'entity') {
				const propOffset = reader.offset + 2 + propInfo.offset // +2 for dataLength
				const placeholderId = view.getBigUint64(propOffset, true)
				// Check if the ID is a placeholder (MSB is 1).
				if ((placeholderId >> 63n) === 1n) {
					// Resolve to the real ID, or default to 0n (null entity) if the placeholder was for a destroyed entity.
					const resolvedId = resolutionMap.get(placeholderId) ?? 0n
					view.setBigUint64(propOffset, resolvedId, true)
				}
			}
		}
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
		// --- 1. Gather & Consolidate Pass ---
		// First, determine the net structural change for each unique entity.
		const entityTransitions = new Map() // Map<entityId, { sourceArchetypeId: number, targetMask: BigUint64Array, componentsToAdd: Map<typeId, {dataOffset, dataLength}> }>

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
		for (const [componentTypeID, addBatch] of modifications.add.entries()) {
			const partIndex = Math.floor(componentTypeID / 64)
			const bitInPart = 1n << BigInt(componentTypeID % 64)
			for (let i = 0; i < addBatch.entityIds.length; i++) {
				const entityId = addBatch.entityIds[i]
				const transition = ensureTransition(entityId)
				if (!transition) continue

				transition.targetMask[partIndex] |= bitInPart
				transition.componentsToAdd.set(componentTypeID, {
					dataOffset: addBatch.dataOffsets[i],
					dataLength: addBatch.dataLengths[i],
				})
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
		const movesByChunk = new Map() // Map<sourceChunkId, Map<targetArchetypeId, moveBatch>>

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
		const removalsByArchetype = new Map() // Map<sourceArchetypeId, entityId[]>

		// --- Pass 3a: All Additions & Copies ---
		for (const [sourceChunkId, targets] of movesByChunk.entries()) {
			for (const [targetArchetypeId, moveBatch] of targets.entries()) {
				const { entityIds, sourceLocations, componentsToAssign } = moveBatch
				const sourceArchetypeId = entityStore.chunkArchetypeIds[sourceChunkId]

				this.entityManager._addEntitiesByCopyingBatch( // This copies data to the new location
					targetArchetypeId,
					sourceArchetypeId,
					sourceLocations,
					entityIds,
					componentsToAssign,
					reader,
					currentTick,
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

	_executeSetDataBatches(setDataMap, reader, currentTick, shouldMarkDirty) {
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
					currentTick,
					shouldMarkDirty,
				)
			}
		}
	}

	_executeSetEnabledBatches(setEnabledMap) {
		for (const [componentTypeID, sets] of setEnabledMap.entries()) {
			const info = Schema.componentInfo[componentTypeID]
			if (!info || !info.isEnableable) {
				console.warn(
					`[CommandBufferExecutor] Attempted to set enabled state for non-enableable component ID ${componentTypeID}.`,
				)
				continue
			}

			const { entityIds, states } = sets
			for (let i = 0; i < entityIds.length; i++) {
				const entityId = entityIds[i]
				const location = this.entityManager.getEntityLocation(entityId)
				if (!location) continue

				const { chunkId, indexInChunk } = location
				const chunkMetadata = entityStore.chunkMetadata[chunkId]
				const componentMetadata = chunkMetadata?.[componentTypeID]
				const enabledMask = componentMetadata?.enabledMask

				if (!enabledMask) {
					continue
				}

				const wordIndex = indexInChunk >>> 5 // Math.floor(i / 32)
				const bitMask = 1 << (indexInChunk & 31) // 1 << (i % 32)
				const shouldBeEnabled = states[i] === 1

				if (shouldBeEnabled) {
					Atomics.or(enabledMask, wordIndex, bitMask)
				} else {
					Atomics.and(enabledMask, wordIndex, ~bitMask)
				}
			}
		}
	}

	_executeMarkDirtyBatches(markDirtyMap) {
		for (const [componentTypeID, marks] of markDirtyMap.entries()) {
			const info = Schema.componentInfo[componentTypeID]
			if (!info || !info.isTracked) {
				console.warn(
					`[CommandBufferExecutor] Attempted to mark dirty for non-tracked component ID ${componentTypeID}.`,
				)
				continue
			}

			const { entityIds, ticks } = marks
			for (let i = 0; i < entityIds.length; i++) {
				const entityId = entityIds[i]
				const tick = ticks[i]
				const location = this.entityManager.getEntityLocation(entityId)
				if (!location) continue

				const { chunkId, indexInChunk } = location
				const chunkMetadata = entityStore.chunkMetadata[chunkId]
				const componentMetadata = chunkMetadata?.[componentTypeID]
				const dirtyMasks = componentMetadata?.dirtyMasks

				if (!dirtyMasks) {
					continue
				}

				const frameIndex = tick % Schema.DIRTY_HISTORY_LENGTH
				const wordsPerFrame = Math.ceil(entityStore.chunkCapacities[chunkId] / 32)
				const wordIndexInFrame = indexInChunk >>> 5
				const bitMask = 1 << (indexInChunk & 31)
				const finalWordIndex = frameIndex * wordsPerFrame + wordIndexInFrame

				Atomics.or(dirtyMasks, finalWordIndex, bitMask)

				// Also update the broad-phase tick
				const componentIdArray = this.entityManager.getComponentTypeIDsForArchetype(location.archetypeId)
				let indexInArchetype = -1
				let low = 0,
					high = componentIdArray.length - 1
				while (low <= high) {
					const mid = (low + high) >>> 1
					const midVal = componentIdArray[mid]
					if (midVal === componentTypeID) {
						indexInArchetype = mid
						break
					} else if (midVal < componentTypeID) low = mid + 1
					else high = mid - 1
				}

				if (indexInArchetype !== -1) this.entityManager._updateArchetypeDirtyTick(chunkId, indexInArchetype, tick)
			}
		}
	}
}
