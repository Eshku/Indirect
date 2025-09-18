import { RawCommandBuffer } from './RawCommandBuffer.js'
import { SortableCommandBuffer, SortKeyLayout, SortPhase } from './SortableCommandBuffer.js'
import { OpCodes } from './CommandOpcodes.js'
import * as Schema from '../ComponentManager/ComponentSchema.js'

// const { payloadCompiler } = await import('./PayloadCompiler.js') // No longer needed.
const SOA_BUFFER_INITIAL_CAPACITY = 1024

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
		// The internal SoA buffer for component modifications has been removed.
		// All data is now written directly as binary payloads into the rawBuffer.
	}

	/**
	 * Clears the buffers for the next frame. Called by the SystemManager after a flush.
	 */
	clear() {
		this.rawBuffer.reset()
		this.sortableBuffer.clear()
	}

	/**
	 * Records a command to add a component to an entity using a pre-compiled binary payload.
	 * @param {bigint} entityId The entity to modify.
	 * @param {{typeID: number, data: ArrayBuffer}} payload The pre-compiled component payload from `payloadCompiler.compileComponentData`.
	 * @param {number} [layer=0] - Execution layer for fine-grained ordering.
	 */
	addComponent(entityId, payload, layer = 0) {
		const offset = this.rawBuffer.offset

		const entityIndex = Number(entityId & 0xffffffffn)
		this.rawBuffer.writeU8(OpCodes.ADD_COMPONENT)
		this.rawBuffer.writeU64(entityId)
		this.rawBuffer.writeU16(payload.typeID)
		this.rawBuffer.writeU16(payload.data.byteLength)
		this.rawBuffer.writeBuffer(payload.data)

		const length = this.rawBuffer.offset - offset
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, entityIndex, 0)
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Records a command to set a component's data on an entity.
	 * Assumes the component already exists. For performance, this is not checked here.
	 * @param {bigint} entityId The entity to modify. * @param {{typeID: number, data: ArrayBuffer}} payload The pre-compiled component payload from `payloadCompiler.compileComponentData`.
	 * @param {number} [layer=0] - Execution layer for fine-grained ordering.
	 */
	setComponentData(entityId, payload, layer = 0) {
		const offset = this.rawBuffer.offset

		const entityIndex = Number(entityId & 0xffffffffn)
		this.rawBuffer.writeU8(OpCodes.SET_COMPONENT_DATA)
		this.rawBuffer.writeU64(entityId)
		this.rawBuffer.writeU16(payload.typeID)
		this.rawBuffer.writeU16(payload.data.byteLength)
		this.rawBuffer.writeBuffer(payload.data)

		const length = this.rawBuffer.offset - offset
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, entityIndex, 2) // Secondary ID to sort after add/remove
		this.sortableBuffer.add(key, offset, length)
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
	 * Records a command to create a new entity from a pre-compiled SoA payload.
	 * This is the primary, high-performance "fast path" for single entity creation,
	 * as it bypasses all runtime data processing.
	 * @param {{archetypeId: number, componentIdMap: Map<number, object>}} payload - The payload from `payloadCompiler.compileEntity`.
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

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.CREATE, layer, 0, 1) // Secondary ID to distinguish from single create
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Records a command to instantiate an entity from a prefab.
	 * This is the high-performance path that expects a pre-compiled payload.
	 * @param {{archetypeId: number, data: ArrayBuffer}} payload The pre-compiled payload from `payloadCompiler.compilePrefabPayload`.
	 * @param {number} [layer=0] The execution layer.
	 */
	instantiate(payload, layer = 0) {
		// Instantiate is just an alias for creating a single entity from a pre-compiled payload.
		this.createEntity(payload, layer)
		//! Recursive children instantiation will be deprecated once we have placeholder entities implemented.
	}

	/**
	 * Records a command to instantiate a batch of entities from a prefab.
	 * @param {string} prefabName - The name of the prefab to instantiate.
	 * @param {number} count - The number of entities to create.
	 * @param {object[]} [overrides=[]] - An array of override objects, one for each new entity.
	 * @param {number} [layer=0]
	 */
	instantiateEntities(prefabName, count, overrides = {}, layer = 0) {
		//! batch operatiom, similar to createEntities, but based on pre-compiled prefabs and with overrides
		//! will call createEntities after resolving all the crap on low-level
		//! Gonna use AoS too.
	}

	/**
	 * Queues a command to destroy every entity matching a query.
	 * @param {import('../../Managers/QueryManager/Query.js').Query} query The query to iterate.
	 * @param {number} [layer=0]
	 */
	destroyEntitiesInQuery(query, layer = 0) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		this.rawBuffer.writeU8(OpCodes.DESTROY_ENTITIES_IN_QUERY)
		this.rawBuffer.writeU32(query.id) // Write query's numeric ID

		const length = this.rawBuffer.offset - startOffset
		// Sort by phase, then layer. Primary/secondary IDs are not needed for query ops.
		const key = SortableCommandBuffer.encodeKey(SortPhase.DESTROY, layer, 0, 0)
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Queues a command to add a component to every entity matching a query.
	 * @param {import('../../Managers/QueryManager/Query.js').Query} query The query to modify.
	 * @param {{typeID: number, data: ArrayBuffer}} payload The pre-compiled component payload.
	 * @param {number} [layer=0]
	 */
	addComponentToQuery(query, payload, layer = 0) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		this.rawBuffer.writeU8(OpCodes.ADD_COMPONENT_TO_QUERY)
		this.rawBuffer.writeU32(query.id)
		this.rawBuffer.writeU16(payload.typeID)
		this.rawBuffer.writeU16(payload.data.byteLength)
		this.rawBuffer.writeBuffer(payload.data)

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, 0, 0)
		this.sortableBuffer.add(key, offset, length)
	}
	
	/**
	 * Queues a command to remove a component from every entity matching a query.
	 * @param {import('../../Managers/QueryManager/Query.js').Query} query
	 * @param {number} componentTypeID
	 * @param {number} [layer=0]
	 */
	removeComponentFromQuery(query, componentTypeID, layer = 0) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		this.rawBuffer.writeU8(OpCodes.REMOVE_COMPONENT_FROM_QUERY)
		this.rawBuffer.writeU32(query.id)
		this.rawBuffer.writeU16(componentTypeID)

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, 0, 0)
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Queues a command to set component data for every entity matching a query.
	 * This is an efficient way to apply in-place data changes to a group of entities.
	 * @param {import('../../Managers/QueryManager/Query.js').Query} query The query to modify.
	 * @param {{typeID: number, data: ArrayBuffer}} payload The pre-compiled component payload.
	 * @param {number} [layer=0]
	 */
	setComponentDataOnQuery(query, payload, layer = 0) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		this.rawBuffer.writeU8(OpCodes.SET_COMPONENT_DATA_ON_QUERY)
		this.rawBuffer.writeU32(query.id)
		this.rawBuffer.writeU16(payload.typeID)
		this.rawBuffer.writeU16(payload.data.byteLength)
		this.rawBuffer.writeBuffer(payload.data)

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, 0, 0)
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * @private
	 */
	_resizeSoA(typeID) {
		// This method is no longer needed as the internal SoA buffer is removed.
	}

	/**
	 * Records a command to create a single new entity from a pre-compiled binary payload.
	 * This is the unified, high-performance "fast path" for single entity creation.
	 * It expects a payload compiled by `PayloadCompiler.compileEntity()`.
	 * @param {{archetypeId: number, data: ArrayBuffer}} payload - The pre-compiled payload.
	 * @param {number} layer The execution layer.
	 */
	createEntity(payload, layer = 0) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		// It writes the opcode, archetype, and the raw binary data directly.
		this.rawBuffer.writeU8(OpCodes.CREATE_ENTITY)
		this.rawBuffer.writeU16(payload.archetypeId)
		this.rawBuffer.writeU16(payload.data.byteLength)
		this.rawBuffer.writeBuffer(payload.data)

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.CREATE, layer, 0, 0)
		this.sortableBuffer.add(key, offset, length)
	}

	getSortedCommands() {
		this.sortableBuffer.sort()
		return {
			sortedOffsets: this.sortableBuffer.getSortedOffsets(),
			sortedLengths: this.sortableBuffer.getSortedLengths(),
		}
	}


}
