import { RawCommandBuffer } from './RawCommandBuffer.js'
import { SortableCommandBuffer, SortKeyLayout, SortPhase } from './SortableCommandBuffer.js'
import { OpCodes } from './CommandOpcodes.js'

const SOA_BUFFER_INITIAL_CAPACITY = 1024

/**
 * high-level API for recording commands into a low-level byte buffer.
 * This is the primary interface systems should use for deferred structural changes.
 * It combines a RawCommandBuffer for data and a SortableCommandBuffer for execution order.
 */
export class CommandBuffer {
	/**
	 * @param {import('../ComponentManager/ComponentManager.js').ComponentManager} componentManager
	 * @param {import('../PrefabManager/PrefabManager.js').PrefabManager} prefabManager
	 */
	constructor(componentManager, prefabManager, archetypeManager) {
		this.rawBuffer = new RawCommandBuffer(componentManager)
		this.sortableBuffer = new SortableCommandBuffer()
		this.componentManager = componentManager
		this.prefabManager = prefabManager
		this.archetypeManager = archetypeManager

		// --- SoA Command Buffer State ---
		// This is the core of the new architecture for component modifications.
		// We pre-allocate TypedArrays for every component property.
		this.soaData = [] // Array of maps: typeId -> { propName -> TypedArray }
		this.soaDataCounts = new Uint32Array(this.componentManager.nextComponentTypeID)
		this.soaDataCapacities = new Uint32Array(this.componentManager.nextComponentTypeID)

		for (let typeID = 0; typeID < this.componentManager.nextComponentTypeID; typeID++) {
			const info = this.componentManager.componentInfo[typeID]
			if (!info || info.byteSize === 0) continue

			this.soaData[typeID] = {}
			this.soaDataCapacities[typeID] = SOA_BUFFER_INITIAL_CAPACITY

			for (const propKey of info.propertyKeys) {
				const propInfo = info.properties[propKey]
				this.soaData[typeID][propKey] = new propInfo.arrayConstructor(SOA_BUFFER_INITIAL_CAPACITY)
			}
		}
	}

	/**
	 * Clears the buffers for the next frame. Called by the SystemManager after a flush.
	 */
	clear() {
		this.rawBuffer.reset()
		this.sortableBuffer.clear()
		this.soaDataCounts.fill(0)
	}

	/**
	 * Records a command to add a component to an entity using the new SoA path.
	 * @param {number} entityId The entity to modify.
	 * @param {number} typeID The component type ID to add.
	 * @param {object} data The high-level data object for the component.
	 * @param {number} [layer=0] - Execution layer for fine-grained ordering.
	 */
	addComponent(entityId, typeID, data = {}, layer = 0) {
		const soaIndex = this._writeSoAData(typeID, data)
		const offset = this.rawBuffer.offset

		this.rawBuffer.writeU8(OpCodes.ADD_COMPONENT)
		this.rawBuffer.writeU32(entityId)
		this.rawBuffer.writeU16(typeID)
		this.rawBuffer.writeU32(soaIndex)

		const length = this.rawBuffer.offset - offset
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, entityId, 0)
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Records a command to set a component's data on an entity.
	 * Assumes the component already exists. For performance, this is not checked here.
	 * @param {number} entityId The entity to modify.
	 * @param {number} typeID The component type ID to set data for.
	 * @param {object} data The high-level data object for the component.
	 * @param {number} [layer=0] - Execution layer for fine-grained ordering.
	 */
	setComponentData(entityId, typeID, data = {}, layer = 0) {
		const soaIndex = this._writeSoAData(typeID, data)
		const offset = this.rawBuffer.offset

		this.rawBuffer.writeU8(OpCodes.SET_COMPONENT_DATA)
		this.rawBuffer.writeU32(entityId)
		this.rawBuffer.writeU16(typeID)
		this.rawBuffer.writeU32(soaIndex)

		const length = this.rawBuffer.offset - offset
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, entityId, 2) // Secondary ID to sort after add/remove
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Records a command to remove a component from an entity.
	 * @param {number} entityId
	 * @param {number} componentTypeID
	 * @param {number} [layer=0]
	 */
	removeComponent(entityId, componentTypeID, layer = 0) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		this.rawBuffer.writeU8(OpCodes.REMOVE_COMPONENT)
		this.rawBuffer.writeU32(entityId)
		this.rawBuffer.writeU16(componentTypeID)

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, entityId, 1) // Use secondary ID to sort removes after adds
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Records a command to destroy an entity.
	 * @param {number} entityId
	 * @param {number} [layer=0]
	 */
	destroyEntity(entityId, layer = 0) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		this.rawBuffer.writeU8(OpCodes.DESTROY_ENTITY)
		this.rawBuffer.writeU32(entityId)

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.DESTROY, layer, entityId, 0)
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Records a command to create a new entity from a high-level component object.
	 * This is the new, unified creation path that leverages the SoA command buffer.
	 * @param {object} components - An object where keys are component names, e.g., `{ Position: {x:10}, Velocity: {vx:5} }`.
	 * @param {number} [layer=0]
	 */
	createEntity(components, layer = 0) {
		const componentIdMap = this.componentManager.createIdMapFromData(components)
		this._createEntityFromIdMap(componentIdMap, layer)
	}

	/**
	 * Records a command to create a batch of identical entities using a pre-compiled payload.
	 * @param {{archetypeId: number, data: ArrayBuffer}} payload - The pre-compiled payload from PayloadCompiler.
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
	 * This is a high-level helper that resolves prefab data and then uses the SoA creation path.
	 * @param {string} prefabName - The name of the prefab to instantiate.
	 * @param {object} [overrides={}] - An object of component data to override the prefab's defaults.
	 * @param {number} [layer=0]
	 */
	instantiate(prefabName, overrides = {}, layer = 0) {
		const baseIdMap = this.prefabManager.getPreprocessedIdMap(prefabName)
		if (!baseIdMap) {
			console.error(`CommandBuffer: Prefab '${prefabName}' not found.`)
			return
		}

		if (Object.keys(overrides).length === 0) {
			// Fast path: No overrides, use the cached map directly.
			this._createEntityFromIdMap(baseIdMap, layer)
		} else {
			// Slower path: Process overrides and merge maps. Still much faster than merging objects.
			const overrideIdMap = this.componentManager.createIdMapFromData(overrides)
			const finalIdMap = new Map([...baseIdMap, ...overrideIdMap])
			this._createEntityFromIdMap(finalIdMap, layer)
		}

		//! Does not support recursive children instantiation currently
		//! Too many optimization paths, gonna come back to this.
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
	 * @param {import('../QueryManager/Query.js').Query} query The query to iterate.
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
	 * @param {import('../QueryManager/Query.js').Query} query The query to modify.
	 * @param {number} typeID The component type ID to add.
	 * @param {object} data The high-level data object for the component.
	 * @param {number} [layer=0]
	 */
	addComponentToQuery(query, typeID, data = {}, layer = 0) {
		const soaIndex = this._writeSoAData(typeID, data)
		const offset = this.rawBuffer.offset
		const startOffset = offset

		this.rawBuffer.writeU8(OpCodes.ADD_COMPONENT_TO_QUERY)
		this.rawBuffer.writeU32(query.id)
		this.rawBuffer.writeU16(typeID)
		this.rawBuffer.writeU32(soaIndex)

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, 0, 0)
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Queues a command to remove a component from every entity matching a query.
	 * @param {import('../QueryManager/Query.js').Query} query
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
	 * @param {import('../QueryManager/Query.js').Query} query The query to modify.
	 * @param {number} typeID The component type ID to set data for.
	 * @param {object} data The high-level data object for the component.
	 * @param {number} [layer=0]
	 */
	setComponentDataOnQuery(query, typeID, data = {}, layer = 0) {
		const soaIndex = this._writeSoAData(typeID, data)
		const offset = this.rawBuffer.offset
		const startOffset = offset

		this.rawBuffer.writeU8(OpCodes.SET_COMPONENT_DATA_ON_QUERY)
		this.rawBuffer.writeU32(query.id)
		this.rawBuffer.writeU16(typeID)
		this.rawBuffer.writeU32(soaIndex)

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.MODIFY, layer, 0, 0)
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * The internal, low-level method for writing a CREATE_ENTITY command from a pre-processed component map.
	 * @param {Map<number, object>} componentIdMap A map of componentTypeID to its raw data object.
	 * @param {number} layer The execution layer.
	 * @private
	 */
	_createEntityFromIdMap(componentIdMap, layer) {
		const offset = this.rawBuffer.offset
		const startOffset = offset

		const archetypeId = this.archetypeManager.getArchetype(componentIdMap.keys())

		this.rawBuffer.writeU8(OpCodes.CREATE_ENTITY)
		this.rawBuffer.writeU16(archetypeId)
		this.rawBuffer.writeU16(componentIdMap.size)

		for (const [typeID, data] of componentIdMap.entries()) {
			const soaIndex = this._writeSoAData(typeID, data)
			this.rawBuffer.writeU16(typeID)
			this.rawBuffer.writeU32(soaIndex)
		}

		const length = this.rawBuffer.offset - startOffset
		const key = SortableCommandBuffer.encodeKey(SortPhase.CREATE, layer, 0, 0)
		this.sortableBuffer.add(key, offset, length)
	}

	/**
	 * Prepares the command buffer for execution by sorting the commands.
	 * @returns {{sortedOffsets: Uint32Array, sortedLengths: Uint32Array}}
	 */
	getSortedCommands() {
		this.sortableBuffer.sort()
		return {
			sortedOffsets: this.sortableBuffer.getSortedOffsets(),
			sortedLengths: this.sortableBuffer.getSortedLengths(),
		}
	}

	/**
	 * Writes component data to the internal SoA buffers.
	 * @param {number} typeID
	 * @param {object} data
	 * @returns {number} The index where the data was written.
	 * @private
	 */
	_writeSoAData(typeID, data) {
		const index = this.soaDataCounts[typeID]++
		if (index >= this.soaDataCapacities[typeID]) {
			this._resizeSoA(typeID)
		}

		const info = this.componentManager.componentInfo[typeID]
		const soaArrays = this.soaData[typeID]
		const compiledDefaults = this.componentManager.getCompiledDefaults(typeID)

		for (const propKey of info.propertyKeys) {
			soaArrays[propKey][index] = data[propKey] ?? compiledDefaults[propKey] ?? 0
		}
		return index
	}

	/**
	 * @private
	 */
	_resizeSoA(typeID) {
		const newCapacity = this.soaDataCapacities[typeID] * 2
		this.soaDataCapacities[typeID] = newCapacity

		const soaArrays = this.soaData[typeID]
		for (const propKey in soaArrays) {
			const newArray = new soaArrays[propKey].constructor(newCapacity)
			newArray.set(soaArrays[propKey])
			soaArrays[propKey] = newArray
		}
	}
}
