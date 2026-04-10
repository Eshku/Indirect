import { RawCommandBuffer } from './RawCommandBuffer.js'
import { SortableCommandBuffer, SortKeyLayout, SortPhase } from './SortableCommandBuffer.js'
import { OpCodes } from './CommandOpcodes.js'
//! Gather and Blit (block image transfer)

/**
 * high-level API for recording commands into a low-level byte buffer.
 * This is the primary interface systems should use for deferred structural changes.
 * It combines a RawCommandBuffer for data and a SortableCommandBuffer for execution order.
 */
export class CommandBuffer {
	constructor() {
		this.rawBuffer = new RawCommandBuffer()
		this.sortableBuffer = new SortableCommandBuffer()
		// We use a BigInt to match the entity ID type.
		this.placeholderIdCounter = 0n
		this.executor = null
		this.systemManager = null
	}

	init(executor, systemManager) {
		this.executor = executor
		this.systemManager = systemManager
	}

	// - do not encode every command, record all first.
	/**
	 * Executes all queued commands, timestamping them with the provided tick.
	 * @param {number} timestampTick The tick value to use for marking changes as dirty.
	 */
	flush(timestampTick) {
		this.executor.execute(this, timestampTick)
	}

	/**
	 * Checks if any commands have been recorded in the buffer.
	 * @returns {boolean} True if the buffer is not empty.
	 */
	hasCommands() {
		return this.sortableBuffer.size > 0
	}

	/**
	 * Records a command to add a component to an entity using a pre-compiled binary payload.
	 * @param {bigint} entityId The entity to modify.
	 * @param {{typeID: number, data: ArrayBuffer}} payload The pre-compiled component payload from `payloadCompiler.compile`.
	 * @param {number} [layer=0] - Execution layer for fine-grained ordering.
	 */
	addComponent(entityId, payload, layer = 0) {
		this._recordSingleComponentPayloadCommand(OpCodes.ADD_COMPONENT, entityId, payload, layer, 0)
	}

	/**
	 * Records a command to add multiple components to an entity using a single pre-compiled payload.
	 * This is more efficient than calling `addComponent` multiple times for the same entity.
	 * @param {bigint} entityId The entity to modify.
	 * @param {{archetypeId: number, data: ArrayBuffer}} payload The pre-compiled payload from `payloadCompiler.compile`.
	 * @param {number} [layer=0] - Execution layer for fine-grained ordering.
	 */
	addComponents(entityId, payload, layer = 0) {
		this._recordMultiComponentPayloadCommand(OpCodes.ADD_COMPONENTS, entityId, payload, layer, 0)
	}

	/**
	 * Records a command to set multiple components' data on an entity using a single pre-compiled payload.
	 * This is more efficient than calling `setComponent` multiple times for the same entity.
	 * Assumes the components already exist.
	 * @param {bigint} entityId The entity to modify.
	 * @param {{archetypeId: number, data: ArrayBuffer}} payload The pre-compiled payload from `payloadCompiler.compile`.
	 * @param {number} [layer=0] - Execution layer for fine-grained ordering.
	 */
	setComponents(entityId, payload, layer = 0) {
		this._recordMultiComponentPayloadCommand(OpCodes.SET_COMPONENTS, entityId, payload, layer, 2)
	}

	/**
	 * Records a command to set multiple components' data on an entity silently (without marking dirty).
	 * @param {bigint} entityId The entity to modify.
	 * @param {{archetypeId: number, data: ArrayBuffer}} payload The pre-compiled payload.
	 * @param {number} [layer=0] - Execution layer.
	 */
	setComponentsSilent(entityId, payload, layer = 0) {
		this._recordMultiComponentPayloadCommand(OpCodes.SET_COMPONENTS_SILENT, entityId, payload, layer, 2)
	}

	/**
	 * Records a command to set a component's data on an entity.
	 * Assumes the component already exists. For performance, this is not checked here.
	 * @param {bigint} entityId The entity to modify. * @param {{typeID: number, data: ArrayBuffer}} payload The pre-compiled component payload from `payloadCompiler.compile`.
	 * @param {number} [layer=0] - Execution layer for fine-grained ordering.
	 */
	setComponent(entityId, payload, layer = 0) {
		this._recordSingleComponentPayloadCommand(OpCodes.SET_COMPONENT, entityId, payload, layer, 2)
	}

	/**
	 * Records a command to set a component's data on an entity WITHOUT marking it as dirty.
	 * This is an advanced, "silent" update for cases like resetting values where no system reaction is desired.
	 * @param {bigint} entityId The entity to modify.
	 * @param {{typeID: number, data: ArrayBuffer}} payload The pre-compiled component payload.
	 * @param {number} [layer=0] - Execution layer.
	 */
	setComponentSilent(entityId, payload, layer = 0) {
		this._recordSingleComponentPayloadCommand(OpCodes.SET_COMPONENT_SILENT, entityId, payload, layer, 2)
	}

	/**
	 * Records a command to remove a component from an entity.
	 * @param {bigint} entityId
	 * @param {number} componentTypeID
	 * @param {number} [layer=0]
	 */
	removeComponent(entityId, componentTypeID, layer = 0) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		const entityIndex = Number(entityId & 0xffffffffn)
		this.rawBuffer.writeU8(OpCodes.REMOVE_COMPONENT)
		this.rawBuffer.writeU64(entityId)
		this.rawBuffer.writeU16(componentTypeID)

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, entityIndex, 1) // Use secondary ID to sort removes after adds
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Records a command to destroy an entity.
	 * @param {bigint} entityId
	 * @param {number} [layer=0]
	 */
	destroyEntity(entityId, layer = 0) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		const entityIndex = Number(entityId & 0xffffffffn)
		this.rawBuffer.writeU8(OpCodes.DESTROY_ENTITY)
		this.rawBuffer.writeU64(entityId)

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.DESTROY, layer, entityIndex, 0)
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Records a highly-efficient command to destroy all entities within a specific chunk.
	 * This is significantly faster than iterating and calling `destroyEntity` on each one.
	 * @param {number} chunkId - The ID of the target chunk.
	 * @param {number} [layer=0] - Execution layer for fine-grained ordering.
	 */
	destroyEntitiesInChunk(chunkId, layer = 0) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		this.rawBuffer.writeU8(OpCodes.DESTROY_ENTITIES_IN_CHUNK)
		this.rawBuffer.writeU16(chunkId) // Use U16 for chunkId as it's the max

		const length = this.rawBuffer.offset - startOffset
		// The primary sort key is the chunkId itself to group deletions.
		const key = SortableCommandBuffer.encodeKey(SortPhase.DESTROY, layer, chunkId, 0)
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Records a highly-efficient command to destroy all entities matching a query.
	 * @param {import('../QueryManager/Query.js').Query} query - The query defining the entities to destroy.
	 * @param {number} [layer=0] - Execution layer for fine-grained ordering.
	 */
	destroyByQuery(query, layer = 0) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		this.rawBuffer.writeU8(OpCodes.DESTROY_BY_QUERY)
		this.rawBuffer.writeU32(query.id) // Use U32 for queryId

		const length = this.rawBuffer.offset - startOffset
		// The primary sort key is the queryId itself to group deletions.
		// This is mostly for consistency; all destroy operations happen in the same phase.
		const key = SortableCommandBuffer.encodeKey(SortPhase.DESTROY, layer, query.id, 0)
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Records a command to create a batch of identical entities from a single pre-compiled AoS payload.
	 * This is a highly efficient way to stamp out many identical entities.
	 * The payload should be created with `compile`.
	 * @param {{archetypeId: number, data: ArrayBuffer}} payload - The pre-compiled AoS payload for a single entity template.
	 * @param {number} count The number of entities to create.
	 * @param {number} [layer=0]
	 */
	createEntities(payload, count, layer = 0) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		this.rawBuffer.writeU8(OpCodes.CREATE_ENTITIES_IDENTICAL)
		this.rawBuffer.writeU32(count)
		this.rawBuffer.writeU16(payload.archetypeId)
		this.rawBuffer.writeU16(payload.data.byteLength)
		this.rawBuffer.writeBuffer(payload.data)
		this._writeTrackableIds(payload)

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.CREATE, layer, 0, 1) // Secondary ID to distinguish from single create
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Records a command to instantiate an entity from a prefab.
	 * This is the high-performance path that expects a pre-compiled payload.
	 * @param {{archetypeId: number, data: ArrayBuffer}} payload The pre-compiled payload from `compile('prefabName', ...)`.
	 * @param {number} [layer=0] The execution layer.
	 */
	instantiate(payload, layer = 0) {
		this.createEntity(payload, layer)
	}

	/**
	 * [PLACEHOLDER] Records a command to add a component to all entities in a specific chunk.
	 * @param {object} chunk - A reference to the target chunk.
	 * @param {{typeID: number, data: ArrayBuffer}} payload - The pre-compiled component payload.
	 * @param {number} [layer=0]
	 */
	addComponentToChunk(chunk, payload, layer = 0) {
		// TODO: Implement chunk-based command. This will add component to every entity in whole chunk.
		// and the payload to the raw buffer.
	}

	/**
	 * Records a command to create a single new entity from a pre-compiled binary payload.
	 * This is the unified, high-performance path for single entity creation.
	 * It expects an AoS payload compiled by `compile`.
	 * @param {{archetypeId: number, data: ArrayBuffer}} payload - The pre-compiled payload.
	 * @param {number} layer The execution layer.
	 * @returns {bigint} A temporary placeholder ID for the entity being created.
	 */
	createEntity(payload, layer = 0) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		const placeholderId = this._generatePlaceholderId()

		// It writes the opcode, archetype, and the raw binary data directly.
		this.rawBuffer.writeU8(OpCodes.CREATE_ENTITY)
		this.rawBuffer.writeU64(placeholderId) // Write the placeholder for resolution
		this.rawBuffer.writeU16(payload.archetypeId)
		// Main component data
		this.rawBuffer.writeU16(payload.data.byteLength)
		this.rawBuffer.writeBuffer(payload.data)
		this._writeTrackableIds(payload)

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.CREATE, layer, 0, 0)
		this.sortableBuffer.add(key, offset, length)
		return placeholderId
	}

	getSortedCommands() {
		this.sortableBuffer.sort()
		return {
			sortedOffsets: this.sortableBuffer.getSortedOffsets(),
			sortedLengths: this.sortableBuffer.getSortedLengths(),
		}
	}

	/**
	 * Clears the buffers for the next frame. Called by the CommandBufferExecutor after a flush.
	 */
	clear() {
		this.rawBuffer.reset()
		this.sortableBuffer.clear()
		this.placeholderIdCounter = 0n
	}

	/**
	 * Generates a new, temporary placeholder ID.
	 * These IDs are marked with the most significant bit set to 1.
	 * @returns {bigint} A new placeholder entity ID.
	 */
	_generatePlaceholderId() {
		// Set the MSB to 1 to mark it as a placeholder.
		return (1n << 63n) | this.placeholderIdCounter++
	}

	_writeTrackableIds(payload) {
		const trackableIds = payload.trackableComponentIds || []
		// Use u8 for length, assuming a single payload won't have > 255 trackable components.
		this.rawBuffer.writeU8(trackableIds.length)
		if (trackableIds.length > 0) {
			for (const id of trackableIds) {
				this.rawBuffer.writeU16(id) // Component IDs are u16
			}
		}
	}

	/**
	 * @private
	 * @param {number} opCode
	 * @param {bigint} entityId
	 * @param {{typeID: number, data: ArrayBuffer}} payload
	 * @param {number} layer
	 * @param {number} secondarySortId
	 */
	_recordSingleComponentPayloadCommand(opCode, entityId, payload, layer, secondarySortId) {
		const offset = this.rawBuffer.offset

		const entityIndex = Number(entityId & 0xffffffffn)
		this.rawBuffer.writeU8(opCode)
		this.rawBuffer.writeU64(entityId)
		this.rawBuffer.writeU16(payload.typeID)
		this.rawBuffer.writeU16(payload.data.byteLength)
		this.rawBuffer.writeBuffer(payload.data)
		this._writeTrackableIds(payload)

		const length = this.rawBuffer.offset - offset
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, entityIndex, secondarySortId)
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * @private
	 * @param {number} opCode
	 * @param {bigint} entityId
	 * @param {{archetypeId: number, data: ArrayBuffer}} payload
	 * @param {number} layer
	 * @param {number} secondarySortId
	 */
	_recordMultiComponentPayloadCommand(opCode, entityId, payload, layer, secondarySortId) {
		const offset = this.rawBuffer.offset

		const entityIndex = Number(entityId & 0xffffffffn)
		this.rawBuffer.writeU8(opCode)
		this.rawBuffer.writeU64(entityId)
		this.rawBuffer.writeU16(payload.archetypeId)
		this.rawBuffer.writeU16(payload.data.byteLength)
		this.rawBuffer.writeBuffer(payload.data)
		this._writeTrackableIds(payload)

		const length = this.rawBuffer.offset - offset
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, entityIndex, secondarySortId)
		this.sortableBuffer.add(key, offset, length)
	}
}

export const commandBuffer = new CommandBuffer()
