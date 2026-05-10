import { RawCommandBuffer } from './RawCommandBuffer.js'
import { SortableCommandBuffer, SortPhase } from './SortableCommandBuffer.js'
import { OpCodes } from './CommandOpcodes.js'

/**
 * A lightweight, data-oriented entity command buffer that implements the "Record" part
 * of the "Record-Sort-Compile" architecture.
 *
 * Its sole responsibility is to provide a high-level API for systems (`addComponent`,
 * `createEntity`, etc.) and translate those calls into simple, "fire-and-forget"
 * writes into flat, linear buffers. It performs no logic, no lookups, and no
 * allocations of its own, making it extremely fast and suitable for parallel execution.
 *
 */

/**
 * ---
 * ### ARCHITECTURAL NOTE: Single-Entity vs. Bulk Commands
 *
 * The command buffer API provides two sets of commands for structural changes:
 * single-entity (e.g., `addComponent`, `removeComponents`) and bulk (e.g., `addComponentsToEntities`).
 * This is a deliberate design choice reflecting two different, highly-optimized execution paths in the engine.
 *
 * #### 1. Single-Entity Path (Optimization: Consolidation)
 * - **Commands:** `addComponent`, `addComponents`, `removeComponent`, `removeComponents`, `setComponents`.
 * - **How it Works:** These commands are sorted by `entityIndex`. The `CommandBufferExecutor` processes
 *   all commands for the *same entity* in a single, contiguous block. If you queue multiple
 *   structural changes for one entity, the executor calculates the single, final archetype change
 *   and creates just **one** "move request".
 * - **When to Use:** When your system's logic is centered around a single entity, even if you are
 *   applying multiple different changes to it. This is the most efficient path for complex,
 *   multi-step modifications to a single entity.
 *
 * #### 2. Bulk Path (Optimization: Throughput)
 * - **Commands:** `addComponentsToEntities`, `removeComponentsFromEntities`, `setEntities`.
 * - **How it Works:** These commands are handled by dedicated helpers that loop through a large array
 *   of entities and apply the *exact same* change to all of them. They do not participate in the
 *   consolidation state machine.
 * - **When to Use:** When applying the *same* change to a large array of *different* entities.
 *
 * **Recommendation:** Always match the command to your intent. Using a bulk command for a single
 * entity (e.g., `removeComponentsFromEntities([oneEntity], ...)`), while not a major performance
 * issue in isolation, will prevent that operation from being consolidated with other changes to the
 * same entity in that frame, leading to suboptimal performance.
 */
export class EntityCommandBuffer {
	init() {
		// The buffer for the final, compiled command stream, produced by flush().
		this.compiledBuffer = new RawCommandBuffer()
		// A temporary buffer to store all payload data for the current frame.
		this.frameDataBuffer = new RawCommandBuffer()
		// A buffer for immediate-mode commands that bypass the gather/compile phase.
		this.immediateCommands = new RawCommandBuffer()

		this.placeholderIdCounter = 0n
		this.sortableBuffer = new SortableCommandBuffer()
	}

	addComponent(entityId, payload, layer = 0) {
		const isPlaceholder = entityId >> 63n === 1n
		const phase = SortPhase.MODIFY
		const generation = isPlaceholder ? 0 : Number((entityId >> 32n) & 0x7fffffffn)

		// The payload for `addComponent` must be for a single component. The compiler
		// now attaches the componentTypeId directly to the payload to avoid lookups here.
		if (payload.componentTypeId === undefined) {
			throw new Error(
				'EntityCommandBuffer.addComponent: Payload is missing componentTypeId. Payloads for addComponent must be compiled from a single component.',
			)
		}
		const componentTypeId = payload.componentTypeId
		let subKey = componentTypeId
		if (isPlaceholder) {
			// Use bit 15 of the sub-key as a flag to indicate this command targets a placeholder.
			// This is safe as MAX_COMPONENTS (256) is much smaller than 2^15.
			subKey |= 1 << 15
		}

		const { payloadOffset, payloadLength } = this._writeSingleEntityPayload(payload)
		const entityIndex = Number(entityId & 0xffffffffn)

		const key = SortableCommandBuffer.encodeKey(phase, layer, entityIndex, subKey)
		// The opAndType stores the payload's archetype ID for the data write pass.
		const opAndType = (OpCodes.ADD_COMPONENT << 16) | payload.archetypeId

		this.sortableBuffer.add(key, payloadOffset, payloadLength, opAndType, generation)
	}

	/**
	 * Records a command to add multiple components to an entity from a single payload.
	 * @param {bigint} entityId The entity to modify.
	 * @param {object} payload The compiled SoA payload containing multiple components.
	 * @param {number} [layer=0] The sorting layer.
	 */
	addComponents(entityId, payload, layer = 0) {
		const isPlaceholder = entityId >> 63n === 1n
		const phase = SortPhase.MODIFY
		const entityIndex = Number(entityId & 0xffffffffn)
		const generation = isPlaceholder ? 0 : Number((entityId >> 32n) & 0x7fffffffn)

		const { payloadOffset, payloadLength } = this._writeSingleEntityPayload(payload)

		const subKey = isPlaceholder ? 1 << 15 : 0 // Subkey 0, but with placeholder flag if needed.
		const key = SortableCommandBuffer.encodeKey(phase, layer, entityIndex, subKey)
		const opAndType = (OpCodes.ADD_COMPONENTS << 16) | payload.archetypeId
		this.sortableBuffer.add(key, payloadOffset, payloadLength, opAndType, generation)
	}

	/**
	 * Replaces the old `setComponent` and `setComponents`. It takes a compiled SoA payload
	 * (which should have `count: 1`) and records a `SET_COMPONENTS` command.
	 * @param {bigint} entityId The entity to modify.
	 * @param {object} payload The compiled SoA payload.
	 * @param {number} [layer=0] The sorting layer.
	 */
	setComponents(entityId, payload, layer = 0) {
		const isPlaceholder = entityId >> 63n === 1n
		const phase = SortPhase.MODIFY
		const entityIndex = Number(entityId & 0xffffffffn)
		const generation = isPlaceholder ? 0 : Number((entityId >> 32n) & 0x7fffffffn)

		const { payloadOffset, payloadLength } = this._writeSingleEntityPayload(payload)

		const subKey = isPlaceholder ? 1 | (1 << 15) : 1
		const key = SortableCommandBuffer.encodeKey(phase, layer, entityIndex, subKey)
		const opAndType = (OpCodes.SET_COMPONENTS << 16) | payload.archetypeId
		this.sortableBuffer.add(key, payloadOffset, payloadLength, opAndType, generation)
	}

	/**
	 * Sets component data silently. This is a data-only operation that bypasses
	 * both narrow-phase dirty tracking (for `isTrackable` components) and any
	 * automatic state mask updates (e.g., for `lifecycleState`).
	 * @param {bigint} entityId The entity to modify.
	 * @param {object} payload The compiled SoA payload.
	 * @param {number} [layer=0] The sorting layer.
	 */
	setComponentsSilent(entityId, payload, layer = 0) {
		const isPlaceholder = entityId >> 63n === 1n
		const phase = SortPhase.MODIFY
		const entityIndex = Number(entityId & 0xffffffffn)
		const generation = isPlaceholder ? 0 : Number((entityId >> 32n) & 0x7fffffffn)

		const { payloadOffset, payloadLength } = this._writeSingleEntityPayload(payload)

		const subKey = isPlaceholder ? 1 | (1 << 15) : 1 // Subkey 1 for data changes
		const key = SortableCommandBuffer.encodeKey(phase, layer, entityIndex, subKey)
		const opAndType = (OpCodes.SET_COMPONENTS_SILENT << 16) | payload.archetypeId
		this.sortableBuffer.add(key, payloadOffset, payloadLength, opAndType, generation)
	}

	/**
	 * Records a command to set the same component data on multiple entities.
	 * This is highly efficient for bulk-resetting pooled entities.
	 * @param {bigint[]} entityIds The array of entities to modify.
	 * @param {object} payload The compiled SoA payload to apply.
	 * @param {number} [layer=0] The sorting layer.
	 */
	setEntities(entityIds, payload, layer = 0) {
		const count = entityIds.length
		if (count === 0) return

		// 1. Write the component data payload ONCE to the frame buffer.
		const { payloadOffset, payloadLength } = this._writeSingleEntityPayload(payload)

		// 2. Record one SET_COMPONENTS command for each entity, all pointing to the same payload data.
		// This is efficient because the heavy data is not duplicated, only the small sortable command entries.
		for (const entityId of entityIds) {
			const isPlaceholder = entityId >> 63n === 1n
			const phase = SortPhase.MODIFY
			const entityIndex = Number(entityId & 0xffffffffn)
			const generation = isPlaceholder ? 0 : Number((entityId >> 32n) & 0x7fffffffn)

			const subKey = isPlaceholder ? 1 | (1 << 15) : 1 // Subkey 1 for data changes
			const key = SortableCommandBuffer.encodeKey(phase, layer, entityIndex, subKey)
			const opAndType = (OpCodes.SET_COMPONENTS << 16) | payload.archetypeId
			this.sortableBuffer.add(key, payloadOffset, payloadLength, opAndType, generation)
		}
	}

	/**
	 * Records a command to add the same components to multiple entities.
	 * @param {bigint[]} entityIds The array of entities to modify.
	 * @param {object} payload The compiled SoA payload to apply.
	 * @param {number} [layer=0] The sorting layer.
	 */
	addComponentsToEntities(entityIds, payload, layer = 0) {
		const entityCount = entityIds.length
		if (entityCount === 0) return

		// --- True Bulk Command Serialization ---
		const payloadStartOffset = this.frameDataBuffer.offset

		// 1. Write the list of entity IDs.
		this.frameDataBuffer.writeU32(entityCount)
		for (const entityId of entityIds) {
			this.frameDataBuffer.writeU64(entityId)
		}

		// 2. Write the component data payload.
		this._writeSingleEntityPayloadToBuffer(payload, this.frameDataBuffer)

		const payloadLength = this.frameDataBuffer.offset - payloadStartOffset

		// 3. Record a SINGLE command.
		// The entityIndex part of the key is irrelevant for bulk commands.
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, 0, 0)
		const opAndType = (OpCodes.BULK_ADD_COMPONENTS << 16) | payload.archetypeId
		// Generation is also irrelevant for bulk commands.
		this.sortableBuffer.add(key, payloadStartOffset, payloadLength, opAndType, 0)
	}

	removeComponent(entityId, componentTypeID, layer = 0) {
		const isPlaceholder = entityId >> 63n === 1n
		const phase = SortPhase.MODIFY
		const entityIndex = Number(entityId & 0xffffffffn)
		const generation = isPlaceholder ? 0 : Number((entityId >> 32n) & 0x7fffffffn)
		const key = SortableCommandBuffer.encodeKey(phase, layer, entityIndex, componentTypeID)
		const opAndType = (OpCodes.REMOVE_COMPONENT << 16) | componentTypeID

		this.sortableBuffer.add(key, 0, 0, opAndType, generation)
	}

	/**
	 * Records a command to remove multiple components from a single entity.
	 * This is more efficient than multiple `removeComponent` calls as it generates a single command.
	 * @param {bigint} entityId The entity to modify.
	 * @param {number[] | Uint16Array} componentTypeIds The component type IDs to remove.
	 * @param {number} [layer=0] The sorting layer.
	 */
	removeComponents(entityId, componentTypeIds, layer = 0) {
		const idsToRemove = componentTypeIds
		const count = idsToRemove.length
		if (count === 0) return

		const isPlaceholder = entityId >> 63n === 1n
		const phase = SortPhase.MODIFY
		const entityIndex = Number(entityId & 0xffffffffn)
		const generation = isPlaceholder ? 0 : Number((entityId >> 32n) & 0x7fffffffn)

		// --- Serialize payload ---
		const payloadStartOffset = this.frameDataBuffer.offset
		this.frameDataBuffer.writeU16(count)
		for (let i = 0; i < count; i++) {
			this.frameDataBuffer.writeU16(idsToRemove[i])
		}
		const payloadLength = this.frameDataBuffer.offset - payloadStartOffset

		const subKey = (isPlaceholder ? 1 << 15 : 0) | 0x7fff
		const key = SortableCommandBuffer.encodeKey(phase, layer, entityIndex, subKey)
		const opAndType = OpCodes.REMOVE_COMPONENTS << 16
		this.sortableBuffer.add(key, payloadStartOffset, payloadLength, opAndType, generation)
	}

	/**
	 * Records a command to remove the same component(s) from multiple entities.
	 * @param {bigint[]} entityIds The array of entities to modify.
	 * @param {number[] | Uint16Array} componentTypeIds The component type IDs to remove.
	 * @param {number} [layer=0] The sorting layer.
	 */
	removeComponentsFromEntities(entityIds, componentTypeIds, layer = 0) {
		const entityCount = entityIds.length
		if (entityCount === 0) return

		const idsToRemoveCount = componentTypeIds.length
		if (idsToRemoveCount === 0) return

		const payloadStartOffset = this.frameDataBuffer.offset

		// 1. Write counts and component IDs first for efficient executor parsing.
		this.frameDataBuffer.writeU32(entityCount)
		this.frameDataBuffer.writeU16(idsToRemoveCount)
		for (const componentTypeId of componentTypeIds) {
			this.frameDataBuffer.writeU16(componentTypeId)
		}

		// 2. Write entity IDs.
		for (const entityId of entityIds) {
			this.frameDataBuffer.writeU64(entityId)
		}

		const payloadLength = this.frameDataBuffer.offset - payloadStartOffset

		// 3. Record a SINGLE command.
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, 0, 0)
		const opAndType = OpCodes.BULK_REMOVE_COMPONENTS << 16
		this.sortableBuffer.add(key, payloadStartOffset, payloadLength, opAndType, 0)
	}

	destroyEntity(entityId, layer = 0) {
		const entityIndex = Number(entityId & 0xffffffffn)
		// Placeholders can be destroyed. If it's a placeholder, its generation is 0.
		const isPlaceholder = entityId >> 63n === 1n
		const generation = isPlaceholder ? 0 : Number((entityId >> 32n) & 0x7fffffffn)
		// Subkey can be 0 as it's not used for sorting destroys.
		const key = SortableCommandBuffer.encodeKey(SortPhase.DESTROY, layer, entityIndex, 0)
		const opAndType = OpCodes.DESTROY_ENTITY << 16

		this.sortableBuffer.add(key, 0, 0, opAndType, generation)
	}

	destroyEntitiesInChunk(chunkId, layer = 0) {
		this.immediateCommands.writeU8(OpCodes.DESTROY_ENTITIES_IN_CHUNK)
		this.immediateCommands.writeU16(chunkId)
	}

	destroyByQuery(query, layer = 0) {
		this.immediateCommands.writeU8(OpCodes.DESTROY_BY_QUERY)
		this.immediateCommands.writeU32(query.id)
	}

	/**
	 * The primary, unified command for creating one or more entities from an SoA payload.
	 * This is the new primary API for entity creation.
	 * @param {object} payload The compiled SoA payload.
	 * @param {number} count The number of entities to instantiate from the payload.
	 * @param {number} [layer=0] The sorting layer.
	 * @returns {bigint | undefined} The first placeholder ID in the batch, or undefined if count is 0.
	 */
	instantiate(payload, count = 1, layer = 0) {
		if (count <= 0) return count === 1 ? undefined : []
		if (count > payload.capacity) {
			throw new Error(`Payload count ${count} exceeds compiled capacity ${payload.capacity}.`)
		}

		const firstPlaceholderId = this._generateFirstPlaceholderId(count)
		const entityIndex = Number(firstPlaceholderId & 0xffffffffn)

		// --- True Zero-Serialization Assembly ---
		const payloadStartOffset = this.frameDataBuffer.offset

		// 1. Write Header directly to frameDataBuffer
		this.frameDataBuffer.writeU32(count)
		// 2. Add padding for 8-byte alignment
		const dataAlignment = 8
		const padding = (dataAlignment - (this.frameDataBuffer.offset % dataAlignment)) % dataAlignment
		for (let i = 0; i < padding; i++) {
			this.frameDataBuffer.writeU8(0)
		}

		// 3. Write data blocks by copying slices directly from the payload's master buffer
		for (const item of payload.layout) {
			// Add padding to align the start of this property's data block.
			const propAlignment = item.bytesPerElement
			const padding = (propAlignment - (this.frameDataBuffer.offset % propAlignment)) % propAlignment
			for (let i = 0; i < padding; i++) {
				this.frameDataBuffer.writeU8(0)
			}

			const sourceBuffer = payload.buffers[item.componentName][item.propKey]
			const sliceView = new Uint8Array(sourceBuffer.buffer, sourceBuffer.byteOffset, count * item.bytesPerElement)
			this.frameDataBuffer.writeBuffer(sliceView)
		}
		const payloadLength = this.frameDataBuffer.offset - payloadStartOffset

		const key = SortableCommandBuffer.encodeKey(SortPhase.CREATE, layer, entityIndex, 0)
		const opAndType = (OpCodes.INSTANTIATE << 16) | payload.archetypeId
		this.sortableBuffer.add(key, payloadStartOffset, payloadLength, opAndType, 0)

		return firstPlaceholderId
	}

	clear() {
		this.frameDataBuffer.reset()
		this.immediateCommands.reset()
		this.sortableBuffer.clear()
		this.placeholderIdCounter = 0n
	}

	_writeSingleEntityPayload(payload) {
		const payloadStartOffset = this.frameDataBuffer.offset

		// 1. Write Header
		this.frameDataBuffer.writeU32(1) // count is always 1

		// 2. Add padding
		const dataAlignment = 8
		const padding = (dataAlignment - (this.frameDataBuffer.offset % dataAlignment)) % dataAlignment
		for (let i = 0; i < padding; i++) {
			this.frameDataBuffer.writeU8(0)
		}

		// 3. Write data blocks
		for (const item of payload.layout) {
			// Add padding to align the start of this property's data block.
			const propAlignment = item.bytesPerElement
			const padding = (propAlignment - (this.frameDataBuffer.offset % propAlignment)) % propAlignment
			for (let i = 0; i < padding; i++) {
				this.frameDataBuffer.writeU8(0)
			}

			const sourceBuffer = payload.buffers[item.componentName][item.propKey]

			const sliceView = new Uint8Array(sourceBuffer.buffer, sourceBuffer.byteOffset, 1 * item.bytesPerElement)
			this.frameDataBuffer.writeBuffer(sliceView)
		}
		const payloadLength = this.frameDataBuffer.offset - payloadStartOffset

		//!
		return { payloadOffset: payloadStartOffset, payloadLength }
	}

	/**
	 * Writes a single-entity SoA payload to a given buffer.
	 * @param {object} payload The compiled payload.
	 * @param {RawCommandBuffer} buffer The buffer to write to.
	 * @private
	 */
	_writeSingleEntityPayloadToBuffer(payload, buffer) {
		// 1. Write Header
		buffer.writeU32(1) // count is always 1

		// 2. Add padding
		const dataAlignment = 8
		const padding = (dataAlignment - (buffer.offset % dataAlignment)) % dataAlignment
		for (let i = 0; i < padding; i++) {
			buffer.writeU8(0)
		}

		// 3. Write data blocks
		for (const item of payload.layout) {
			// Add padding to align the start of this property's data block.
			const propAlignment = item.bytesPerElement
			const padding = (propAlignment - (buffer.offset % propAlignment)) % propAlignment
			for (let i = 0; i < padding; i++) {
				buffer.writeU8(0)
			}

			const sourceBuffer = payload.buffers[item.componentName][item.propKey]
			const sliceView = new Uint8Array(sourceBuffer.buffer, sourceBuffer.byteOffset, 1 * item.bytesPerElement)
			buffer.writeBuffer(sliceView)
		}
	}

	_generatePlaceholderId() {
		const placeholderIndex = this.placeholderIdCounter++

		return (1n << 63n) | placeholderIndex
	}

	_generateFirstPlaceholderId(count) {
		const firstId = (1n << 63n) | this.placeholderIdCounter
		this.placeholderIdCounter += BigInt(count)
		return firstId
	}
}

export const entityCommandBuffer = new EntityCommandBuffer()
