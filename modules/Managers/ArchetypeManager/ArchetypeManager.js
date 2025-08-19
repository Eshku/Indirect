const { DirtyMarker } = await import(`${PATH_MANAGERS}/ArchetypeManager/DirtyMarker.js`)
const { SoAArchetypeAccessor, AoSArchetypeAccessor } = await import(`${PATH_MANAGERS}/ArchetypeManager/Accessors.js`)
const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)

/**
 * @fileoverview Manages archetypes, which are unique combinations of components.
 *
 * ---
 *
 * ### Architectural Philosophy: Immortal Archetype Definitions
 *
 * A core performance principle of this ECS is that archetype definitions, once created,
 * are considered "immortal". They are never deleted, even if they become empty.
 *
 * #### The Problem: Archetype Churn
 *
 * A naive approach would be to delete an archetype as soon as its last entity is removed.
 * However, this creates a significant performance bottleneck known as "archetype churn":
 *
 * 1.  **Deletion Cost:** When an archetype is deleted, the `ArchetypeManager` must notify the
 *     `QueryManager`. The `QueryManager` then has to iterate through **every active query**
 *     in the engine to remove the deleted archetype from their lists of matching archetypes.
 *
 * 2.  **Re-creation Cost:** If an entity with the same component signature is created shortly
 *     after (a very common pattern, e.g., spawning new enemies of the same type that were
 *     just killed), a new archetype must be created. This again forces the `QueryManager`
 *     to iterate through **every active query** to see if this new archetype is a match.
 *
 * This process, when repeated frequently, leads to severe performance degradation.
 *
 * #### The Solution: Keep Empty Archetypes
 *
 * By treating archetype definitions as immortal, we completely eliminate this churn. When an archetype becomes empty, its large data arrays can be garbage collected, but the lightweight `Archetype` metadata object itself is kept in the manager's map. This is a classic memory-for-speed trade-off that is fundamental to high-performance ECS engines like Unity DOTS and Bevy.
 */

/**
 * The maximum number of unique archetypes the engine can support.
 * @type {number}
 */
export const MAX_ARCHETYPES = 4096

export class ArchetypeManager {
	constructor() {
		/**
		 * Stores all known archetypes, keyed by their unique BigInt bitmask.
		 * The value is the small integer `id` for the archetype.
		 * @type {Map<bigint, number>}
		 */
		this.archetypeLookup = new Map()

		/**
		 * A counter to assign a unique, small integer ID to each new archetype.
		 * This ID is the primary way to reference an archetype.
		 * @type {number}
		 */
		this.nextArchetypeId = 0

		/**
		 * A centralized, high-performance array to store the max dirty tick for each archetype.
		 * @type {Uint32Array}
		 */
		this.archetypeMaxDirtyTicks = new Uint32Array(MAX_ARCHETYPES)

		/**
		 * The core data store. Instead of `Archetype` objects, we store plain data objects
		 * in an array, indexed by the archetype's `id`.
		 */
		this.archetypeData = []
	}

	/**
	 * Initializes the manager and sets up dependencies.
	 */
	async init() {
		this.queryManager = theManager.getManager('QueryManager')
		this.componentManager = theManager.getManager('ComponentManager')
		this.systemManager = theManager.getManager('SystemManager')
	}

	/**
	 * Generates a unique BigInt bitmask for an archetype from a set of component type IDs.
	 * @param {number[]} componentTypeIDs - An array of component type IDs.
	 * @returns {bigint} The unique bitmask for this combination of components.
	 */
	generateArchetypeMask(componentTypeIDs) {
		// This method relies on the ComponentManager to provide valid bit flags for each typeID.
		// The ComponentManager is responsible for enforcing the MAX_COMPONENTS limit, ensuring
		// that any typeID used here is within the valid range.
		let mask = 0n
		for (const typeID of componentTypeIDs) {
			if (typeID === undefined) {
				const definedComponentNames = componentTypeIDs
					.filter(id => id !== undefined)
					.map(id => this.componentManager.getComponentNameByTypeID(id))
					.join(', ')
				throw new TypeError(
					`ArchetypeManager.generateArchetypeMask: Received 'undefined' in componentTypeIDs array. ` +
						`This usually means a component class was not found by name or was not registered. ` +
						`Provided components: [${definedComponentNames}, undefined]`
				)
			}
			mask |= this.componentManager.componentBitFlags[typeID]
		}
		return mask
	}

	/**
	 * Gets an existing archetype that matches the given component type IDs,
	 * or creates a new one if it doesn't exist.
	 * @param {number[]} componentTypeIDs - An array of component type IDs.
	 * @returns {number} The internal ID of the found or newly created archetype.
	 */
	getArchetype(componentTypeIDs) {
		// Always sort a copy of the component type IDs to ensure consistent archetype identification.
		// This prevents bugs from callers who might provide an unsorted array.
		const sortedTypeIDs = [...componentTypeIDs].sort((a, b) => a - b)
		const archetypeMask = this.generateArchetypeMask(sortedTypeIDs)
		return this.getArchetypeByMask(archetypeMask, sortedTypeIDs)
	}

	/**
	 * Gets an existing archetype that matches the given bitmask,
	 * or creates a new one if it doesn't exist. This is a high-performance
	 * method for when the mask is already known.
	 * @param {bigint} archetypeMask - The bitmask of the archetype.
	 * @param {number[]} [sortedTypeIDs] - Optional pre-sorted type IDs. If not provided, they will be derived from the mask.
	 * @returns {number} The internal ID of the found or newly created archetype.
	 */
	getArchetypeByMask(archetypeMask, sortedTypeIDs) {
		if (this.archetypeLookup.has(archetypeMask)) {
			return this.archetypeLookup.get(archetypeMask)
		}

		// Mask doesn't exist, so we need to create the new archetype data.
		const id = this.nextArchetypeId++
		if (id >= MAX_ARCHETYPES) {
			throw new Error(
				`ArchetypeManager: Maximum number of archetypes (${MAX_ARCHETYPES}) reached. ` +
					`If this is intentional, increase MAX_ARCHETYPES.`
			)
		}

		if (!sortedTypeIDs) {
			sortedTypeIDs = this.componentManager.getComponentTypesFromMask(archetypeMask)
		}

		const hotComponentTypeIDs = []
		const coldComponentTypeIDs = []
		const componentArrays = []
		const dirtyTicksArrays = []

		for (const typeID of sortedTypeIDs) {
			const info = this.componentManager.componentInfo[typeID]
			if (info.storage === 'Hot') {
				hotComponentTypeIDs.push(typeID)
			} else {
				coldComponentTypeIDs.push(typeID)
				componentArrays[typeID] = []
				dirtyTicksArrays[typeID] = []
			}
		}

		const newData = {
			mask: archetypeMask,
			id: id,
			componentTypeIDs: new Set(sortedTypeIDs),
			hotComponentTypeIDs,
			coldComponentTypeIDs,
			capacity: 0,
			entities: null,
			entityCount: 0,
			componentArrays,
			dirtyTicksArrays,
			transitions: { add: {}, remove: {} },
			markerCache: [],
			accessorCache: [],
		}

		this.archetypeData[id] = newData
		this.archetypeLookup.set(archetypeMask, id)
		this.queryManager.registerArchetype(id) // Notify QueryManager
		return id
	}

	/**
	 * Retrieves all archetype data for a given internal ID. This is a critical
	 * O(1) operation. The `archetypeId` is a direct index into the `archetypeData`
	 * array, not a value to be searched for. This design is fundamental to the
	 * engine's performance.
	 * @param {number} archetypeId - The internal ID of the archetype.
	 * @returns {object} The raw data object for the archetype.
	 */
	getData(archetypeId) {
		return this.archetypeData[archetypeId]
	}

	/**
	 * Checks if an archetype has a specific component type.
	 * @param {number} archetypeId - The internal ID of the archetype.
	 * @param {number} componentTypeID - The type ID of the component.
	 * @returns {boolean}
	 */
	hasComponentType(archetypeId, componentTypeID) {
		return this.archetypeData[archetypeId]?.componentTypeIDs.has(componentTypeID)
	}

	/**
	 * Gets a high-performance, archetype-scoped component accessor.
	 * @param {number} archetypeId The internal ID of the archetype.
	 * @param {number} typeID The component type ID.
	 * @returns {SoAArchetypeAccessor | AoSArchetypeAccessor} A cached accessor for this archetype.
	 */
	getComponentAccessor(archetypeId, typeID) {
		const data = this.archetypeData[archetypeId]
		if (data.accessorCache[typeID]) {
			return data.accessorCache[typeID]
		}

		const info = this.componentManager.componentInfo[typeID]
		const accessor =
			info.storage === 'Hot'
				? new SoAArchetypeAccessor(this, archetypeId, typeID)
				: new AoSArchetypeAccessor(this, archetypeId, typeID)

		data.accessorCache[typeID] = accessor
		return accessor
	}

	/**
	 * Gets a high-performance, archetype-scoped dirty marker.
	 * @param {number} archetypeId The internal ID of the archetype.
	 * @param {number} typeID The component type ID.
	 * @param {number} currentTick The current system tick.
	 * @returns {DirtyMarker | undefined} A cached marker for this archetype, or undefined if the component does not exist.
	 */
	getDirtyMarker(archetypeId, typeID, currentTick) {
		const data = this.archetypeData[archetypeId]
		if (!data.componentTypeIDs.has(typeID)) return undefined

		let marker = data.markerCache[typeID]

		if (!marker) {
			marker = new DirtyMarker()
			data.markerCache[typeID] = marker
		}

		this.updateArchetypeMaxTick(archetypeId, currentTick)
		marker._init(data.dirtyTicksArrays[typeID], currentTick)

		return marker
	}

	/**
	 * Resizes the internal arrays for a given archetype.
	 * @param {number} archetypeId - The internal ID of the archetype.
	 * @param {number} newCapacity - The new capacity required.
	 * @private
	 */
	_resize(archetypeId, newCapacity) {
		const data = this.archetypeData[archetypeId]
		data.capacity = newCapacity

		const newEntities = new Uint32Array(newCapacity)
		if (data.entities) {
			newEntities.set(data.entities)
		}
		data.entities = newEntities

		for (const typeID of data.hotComponentTypeIDs) {
			const info = this.componentManager.componentInfo[typeID]
			const oldPropArrays = data.componentArrays[typeID]
			const newPropArrays = {}
			for (const propKey of info.propertyKeys) {
				const constructor = info.properties[propKey].arrayConstructor
				const buffer = new SharedArrayBuffer(newCapacity * constructor.BYTES_PER_ELEMENT)
				const newArray = new constructor(buffer)
				if (oldPropArrays?.[propKey]) {
					newArray.set(oldPropArrays[propKey])
				}
				newPropArrays[propKey] = newArray
			}
			data.componentArrays[typeID] = newPropArrays

			const newDirtyTicks = new Uint32Array(newCapacity)
			if (data.dirtyTicksArrays[typeID]) {
				newDirtyTicks.set(data.dirtyTicksArrays[typeID])
			}
			data.dirtyTicksArrays[typeID] = newDirtyTicks
		}
	}

	/**
	 * Gets the tick at which a specific component of an entity was last marked dirty.
	 * @param {number} archetypeId - The internal ID of the archetype.
	 * @param {number} entityIndex - The index of the entity.
	 * @param {number} componentTypeID - The type ID of the component.
	 * @returns {number | undefined} The dirty tick, or undefined if not found.
	 */
	getDirtyTick(archetypeId, entityIndex, componentTypeID) {
		const data = this.archetypeData[archetypeId]
		const dirtyTicksArray = data.dirtyTicksArrays[componentTypeID]
		if (dirtyTicksArray && entityIndex < data.entityCount) {
			return dirtyTicksArray[entityIndex]
		}
		return undefined
	}

	/**
	 * Adds an entity to an archetype and initializes its component data.
	 * @param {number} archetypeId - The internal ID of the archetype.
	 * @param {number} entityID - The ID of the entity to add.
	 * @param {Map<number, object>} componentsDataMap - A map of componentTypeID to raw component data.
	 * @param {number} currentTick - The current system tick.
	 * @returns {number} The new index of the entity in this archetype.
	 */
	addEntity(archetypeId, entityID, componentsDataMap, currentTick) {
		const data = this.archetypeData[archetypeId]
		const index = data.entityCount
		if (index >= data.capacity) {
			this._resize(archetypeId, Math.max(index + 1, data.capacity * 2, 4))
		}
		data.entityCount++

		data.entities[index] = entityID
		this.updateArchetypeMaxTick(archetypeId, currentTick)

		// Process Hot components
		for (const typeID of data.hotComponentTypeIDs) {
			const info = this.componentManager.componentInfo[typeID]
			const componentData = componentsDataMap.get(typeID)
			const defaultInstance = this.componentManager.getDefaultInstance(typeID)
			this._updateHotComponentData(archetypeId, index, componentData, info, defaultInstance)
			data.dirtyTicksArrays[typeID][index] = currentTick
		}

		// Process Cold components
		for (const typeID of data.coldComponentTypeIDs) {
			const componentData = componentsDataMap.get(typeID)
			const ComponentClass = this.componentManager.getComponentClassByTypeID(typeID)
			data.componentArrays[typeID][index] = this.componentManager.createComponentInstance(
				ComponentClass,
				componentData,
				entityID
			)
			data.dirtyTicksArrays[typeID][index] = currentTick
		}

		return index
	}

	/**
	 * Adds a batch of entities to an archetype, initializing their component data.
	 * @param {number} archetypeId - The internal ID of the archetype.
	 * @param {number[]} entities - An array of entity IDs to add.
	 * @param {Map<number, object>[]} componentsDataMaps - An array of component data maps.
	 * @param {number} currentTick - The current system tick.
	 * @returns {number} The starting index of the added entities.
	 */
	addEntitiesBatch(archetypeId, entities, componentsDataMaps, currentTick) {
		const data = this.archetypeData[archetypeId]
		const count = entities.length
		if (data.entityCount + count > data.capacity) {
			this._resize(archetypeId, Math.max(data.entityCount + count, data.capacity * 2))
		}

		const startIndex = data.entityCount
		const endIndex = startIndex + count

		data.entities.set(entities, startIndex)
		this.updateArchetypeMaxTick(archetypeId, currentTick)

		// This loop is structured as (type -> property -> entity) to maximize cache
		// efficiency by writing to one TypedArray at a time for the entire batch.
		for (const typeID of data.hotComponentTypeIDs) {
			const info = this.componentManager.componentInfo[typeID]
			const propArrays = data.componentArrays[typeID]
			const dirtyTicksArray = data.dirtyTicksArrays[typeID]
			const defaultInstance = this.componentManager.getDefaultInstance(typeID)

			for (const propName of info.originalSchemaKeys) {
				const repInfo = info.representations[propName]

				// This inner loop is now highly optimizable by the JIT.
				for (let i = 0; i < count; i++) {
					const entityIndex = startIndex + i
					const userData = componentsDataMaps[i].get(typeID)
					const value = userData?.[propName] ?? defaultInstance[propName]

					if (repInfo?.type === 'string') {
						const { offset, length } = this.componentManager.stringInterningTable.intern(value ?? '')
						propArrays[`${propName}_offset`][entityIndex] = offset
						propArrays[`${propName}_length`][entityIndex] = length
					} else if (repInfo?.type === 'array') {
						const { capacity, lengthProperty } = repInfo
						const sourceArray = value ?? []
						const liveLength = Math.min(sourceArray.length, capacity)
						for (let itemIndex = 0; itemIndex < capacity; itemIndex++) {
							propArrays[`${propName}${itemIndex}`][entityIndex] =
								itemIndex < liveLength ? sourceArray[itemIndex] || 0 : 0
						}
						if (lengthProperty && propArrays[lengthProperty]) {
							propArrays[lengthProperty][entityIndex] = liveLength
						}
					} else if (repInfo?.type === 'enum') {
						const { enumMap } = repInfo
						propArrays[propName][entityIndex] = (typeof value === 'string' ? enumMap[value] : value) ?? 0
					} else if (propArrays[propName]) {
						propArrays[propName][entityIndex] = value ?? 0
					}
				}
			}
			dirtyTicksArray.fill(currentTick, startIndex, endIndex)
		}

		for (const typeID of data.coldComponentTypeIDs) {
			const ComponentClass = this.componentManager.getComponentClassByTypeID(typeID)
			const componentArray = data.componentArrays[typeID]
			const dirtyTicksArray = data.dirtyTicksArrays[typeID]
			for (let i = 0; i < count; i++) {
				const index = startIndex + i
				componentArray[index] = this.componentManager.createComponentInstance(
					ComponentClass,
					componentsDataMaps[i].get(typeID),
					entities[i]
				)
				dirtyTicksArray[index] = currentTick
			}
		}

		data.entityCount = endIndex
		return startIndex
	}

	/**
	 * Adds a batch of identical entities to an archetype.
	 * @param {number} archetypeId - The internal ID of the archetype.
	 * @param {number[]} entities - An array of entity IDs to add.
	 * @param {Map<number, object>} componentIdMap - A single component data map for all entities.
	 * @param {number} currentTick - The current system tick.
	 * @returns {number} The starting index of the added entities.
	 */
	addIdenticalEntitiesBatch(archetypeId, entities, componentIdMap, currentTick) {
		const data = this.archetypeData[archetypeId]
		const count = entities.length
		if (data.entityCount + count > data.capacity) {
			this._resize(archetypeId, Math.max(data.entityCount + count, data.capacity * 2))
		}

		const startIndex = data.entityCount
		const endIndex = startIndex + count

		data.entities.set(entities, startIndex)
		this.updateArchetypeMaxTick(archetypeId, currentTick)

		for (const typeID of data.hotComponentTypeIDs) {
			const info = this.componentManager.componentInfo[typeID]
			const dirtyTicksArray = data.dirtyTicksArrays[typeID]
			const defaultInstance = this.componentManager.getDefaultInstance(typeID)

			const userData = componentIdMap.get(typeID)
			this._fillHotComponentData(archetypeId, startIndex, endIndex, userData, info, defaultInstance)
			dirtyTicksArray.fill(currentTick, startIndex, endIndex)
		}

		for (const typeID of data.coldComponentTypeIDs) {
			const ComponentClass = this.componentManager.getComponentClassByTypeID(typeID)
			const componentArray = data.componentArrays[typeID]
			const dirtyTicksArray = data.dirtyTicksArrays[typeID]
			const userData = componentIdMap.get(typeID)
			for (let i = 0; i < count; i++) {
				const index = startIndex + i
				componentArray[index] = this.componentManager.createComponentInstance(ComponentClass, userData, entities[i])
				dirtyTicksArray[index] = currentTick
			}
		}

		data.entityCount = endIndex
		return startIndex
	}

	/**
	 * Adds an entity by copying data from a source archetype.
	 * @param {number} newArchetypeId - The destination archetype ID.
	 * @param {number} entityID - The ID of the entity to add.
	 * @param {number} sourceArchetypeId - The source archetype ID.
	 * @param {number} sourceEntityIndex - The index in the source archetype.
	 * @param {number} currentTick - The current system tick.
	 * @returns {number} The new index of the entity.
	 */
	addEntityByCopying(newArchetypeId, entityID, sourceArchetypeId, sourceEntityIndex, currentTick) {
		const data = this.archetypeData[newArchetypeId]
		const sourceData = this.archetypeData[sourceArchetypeId]
		const newIndex = data.entityCount
		if (newIndex >= data.capacity) {
			this._resize(newArchetypeId, Math.max(newIndex + 1, data.capacity * 2, 4))
		}
		data.entityCount++

		data.entities[newIndex] = entityID
		this.updateArchetypeMaxTick(newArchetypeId, currentTick)

		for (const typeID of data.hotComponentTypeIDs) {
			const targetPropArrays = data.componentArrays[typeID]
			const sourcePropArrays = sourceData.componentArrays[typeID]
			for (const propKey of this.componentManager.componentInfo[typeID].propertyKeys) {
				targetPropArrays[propKey][newIndex] = sourcePropArrays[propKey][sourceEntityIndex]
			}
			data.dirtyTicksArrays[typeID][newIndex] = currentTick
		}

		for (const typeID of data.coldComponentTypeIDs) {
			data.componentArrays[typeID][newIndex] = sourceData.componentArrays[typeID][sourceEntityIndex]
			data.dirtyTicksArrays[typeID][newIndex] = currentTick
		}

		return newIndex
	}

	/**
	 * Adds an entity by copying and adding/overwriting with new data.
	 * @param {number} newArchetypeId - The destination archetype ID.
	 * @param {number} entityID - The ID of the entity to add.
	 * @param {number} sourceArchetypeId - The source archetype ID.
	 * @param {number} sourceEntityIndex - The index in the source archetype.
	 * @param {number} currentTick - The current system tick.
	 * @param {Map<number, object>} newOrUpdatedComponents - New component data.
	 * @returns {number} The new index of the entity.
	 */
	addEntityWithNewData(
		newArchetypeId,
		entityID,
		sourceArchetypeId,
		sourceEntityIndex,
		currentTick,
		newOrUpdatedComponents
	) {
		const data = this.archetypeData[newArchetypeId]
		const sourceData = this.archetypeData[sourceArchetypeId]
		const newIndex = data.entityCount
		if (newIndex >= data.capacity) {
			this._resize(newArchetypeId, Math.max(newIndex + 1, data.capacity * 2, 4))
		}
		data.entityCount++

		data.entities[newIndex] = entityID
		this.updateArchetypeMaxTick(newArchetypeId, currentTick)

		for (const typeID of data.hotComponentTypeIDs) {
			const info = this.componentManager.componentInfo[typeID]
			const hasNewData = newOrUpdatedComponents.has(typeID)

			if (hasNewData) {
				const defaultInstance = this.componentManager.getDefaultInstance(typeID)
				this._updateHotComponentData(
					newArchetypeId,
					newIndex,
					newOrUpdatedComponents.get(typeID),
					info,
					defaultInstance
				)
			} else {
				const targetPropArrays = data.componentArrays[typeID]
				const sourcePropArrays = sourceData.componentArrays[typeID]
				if (sourcePropArrays) {
					for (const propKey of info.propertyKeys) {
						targetPropArrays[propKey][newIndex] = sourcePropArrays[propKey][sourceEntityIndex]
					}
				}
			}
			data.dirtyTicksArrays[typeID][newIndex] = currentTick
		}

		for (const typeID of data.coldComponentTypeIDs) {
			const hasNewData = newOrUpdatedComponents.has(typeID)
			let componentInstance
			if (hasNewData) {
				const componentData = newOrUpdatedComponents.get(typeID)
				const ComponentClass = this.componentManager.getComponentClassByTypeID(typeID)
				componentInstance = this.componentManager.createComponentInstance(ComponentClass, componentData, entityID)
			} else {
				componentInstance = sourceData.componentArrays[typeID]?.[sourceEntityIndex]
			}
			data.componentArrays[typeID][newIndex] = componentInstance
			data.dirtyTicksArrays[typeID][newIndex] = currentTick
		}

		return newIndex
	}

	/**
	 * Removes an entity from an archetype using swap-and-pop.
	 * @param {number} archetypeId - The internal ID of the archetype.
	 * @param {number} indexToRemove - The index of the entity to remove.
	 * @returns {number | undefined} The ID of the entity that was moved, or undefined.
	 */
	removeEntityAtIndex(archetypeId, indexToRemove) {
		const data = this.archetypeData[archetypeId]
		const lastIndex = data.entityCount - 1
		if (indexToRemove > lastIndex || indexToRemove < 0) {
			return undefined
		}

		const swappedEntityId = data.entities[lastIndex]

		if (indexToRemove !== lastIndex) {
			for (const typeID of data.hotComponentTypeIDs) {
				const propArrays = data.componentArrays[typeID]
				for (const propKey of this.componentManager.componentInfo[typeID].propertyKeys) {
					propArrays[propKey][indexToRemove] = propArrays[propKey][lastIndex]
				}
				data.dirtyTicksArrays[typeID][indexToRemove] = data.dirtyTicksArrays[typeID][lastIndex]
			}
			for (const typeID of data.coldComponentTypeIDs) {
				data.componentArrays[typeID][indexToRemove] = data.componentArrays[typeID][lastIndex]
				data.dirtyTicksArrays[typeID][indexToRemove] = data.dirtyTicksArrays[typeID][lastIndex]
			}
			data.entities[indexToRemove] = swappedEntityId
		}

		data.entityCount--

		for (const typeID of data.coldComponentTypeIDs) {
			data.componentArrays[typeID].length = data.entityCount
			data.dirtyTicksArrays[typeID].length = data.entityCount
		}

		return indexToRemove !== lastIndex ? swappedEntityId : undefined
	}

	/**
	 * Removes a batch of entities from an archetype using compaction.
	 * @param {number} archetypeId - The internal ID of the archetype.
	 * @param {Set<number>} indicesToRemove - A set of entity indices to remove.
	 * @returns {Map<number, number>} A map of `entityId -> newIndex` for moved entities.
	 */
	compactAndRemove(archetypeId, indicesToRemove) {
		const data = this.archetypeData[archetypeId]
		const movedEntities = new Map()
		if (indicesToRemove.size === 0) {
			return movedEntities
		}

		let i = 0
		let j = data.entityCount - 1

		while (i <= j) {
			while (i <= j && !indicesToRemove.has(i)) {
				i++
			}
			while (i <= j && indicesToRemove.has(j)) {
				j--
			}

			if (i < j) {
				const movedEntityId = data.entities[j]

				for (const typeID of data.hotComponentTypeIDs) {
					const propArrays = data.componentArrays[typeID]
					for (const propKey of this.componentManager.componentInfo[typeID].propertyKeys) {
						propArrays[propKey][i] = propArrays[propKey][j]
					}
					data.dirtyTicksArrays[typeID][i] = data.dirtyTicksArrays[typeID][j]
				}
				for (const typeID of data.coldComponentTypeIDs) {
					data.componentArrays[typeID][i] = data.componentArrays[typeID][j]
					data.dirtyTicksArrays[typeID][i] = data.dirtyTicksArrays[typeID][j]
				}
				data.entities[i] = movedEntityId
				movedEntities.set(movedEntityId, i)
				i++
				j--
			}
		}

		data.entityCount = i
		for (const typeID of data.coldComponentTypeIDs) {
			data.componentArrays[typeID].length = data.entityCount
			data.dirtyTicksArrays[typeID].length = data.entityCount
		}
		return movedEntities
	}

	/**
	 * Sets component data for a batch of entities within an archetype.
	 * @param {number} archetypeId - The internal ID of the archetype.
	 * @param {Array<{entityIndex: number, componentsToUpdate: Map<number, object>}>} batchedUpdates - The modifications.
	 * @param {number} currentTick - The current game tick.
	 */
	setEntitiesComponents(archetypeId, batchedUpdates, currentTick) {
		const data = this.archetypeData[archetypeId]
		const updatesByComponent = new Map()

		for (const { entityIndex, componentsToUpdate } of batchedUpdates) {
			for (const [typeID, cData] of componentsToUpdate.entries()) {
				if (!updatesByComponent.has(typeID)) {
					updatesByComponent.set(typeID, [])
				}
				updatesByComponent.get(typeID).push({ entityIndex, data: cData })
			}
		}

		if (updatesByComponent.size > 0) {
			this.updateArchetypeMaxTick(archetypeId, currentTick)
		}

		for (const [typeID, updates] of updatesByComponent.entries()) {
			const info = this.componentManager.componentInfo[typeID]
			if (!info) continue

			const dirtyTicksArray = data.dirtyTicksArrays[typeID]
			if (dirtyTicksArray) {
				for (const { entityIndex } of updates) {
					dirtyTicksArray[entityIndex] = currentTick
				}
			}

			if (info.storage === 'Hot') {
				const propArrays = data.componentArrays[typeID]
				for (const { entityIndex, data: updateData } of updates) {
					if (!updateData) continue
					this._updateHotComponentDataFromRaw(archetypeId, entityIndex, updateData, info)
				}
			} else {
				const componentArray = data.componentArrays[typeID]
				for (const { entityIndex, data: updateData } of updates) {
					const existingInstance = componentArray[entityIndex]
					if (existingInstance && updateData) {
						Object.assign(existingInstance, updateData)
					}
				}
			}
		}
	}

	/**
	 * Sets component data for all entities within a specific chunk.
	 * @param {number} archetypeId - The internal ID of the archetype.
	 * @param {import('./Chunk.js').Chunk} chunk - The chunk to update.
	 * @param {number} componentTypeID - The type ID of the component.
	 * @param {object} updateData - The new data for the component.
	 * @param {number} currentTick - The current game tick.
	 */
	setChunkComponents(archetypeId, chunk, componentTypeID, updateData, currentTick) {
		const data = this.archetypeData[archetypeId]
		if (!data.componentTypeIDs.has(componentTypeID) || !updateData) {
			return
		}

		this.updateArchetypeMaxTick(archetypeId, currentTick)
		data.dirtyTicksArrays[componentTypeID]?.fill(currentTick, chunk.startIndex, chunk.startIndex + chunk.count)

		const info = this.componentManager.componentInfo[componentTypeID]
		const start = chunk.startIndex
		const end = chunk.startIndex + chunk.count

		if (info.storage === 'Hot') {
			const propArrays = data.componentArrays[componentTypeID]
			for (const propName in updateData) {
				if (Object.prototype.hasOwnProperty.call(updateData, propName)) {
					const value = updateData[propName]
					const repInfo = info.representations[propName]

					if (repInfo?.type === 'string') {
						const { offset, length } = this.componentManager.stringInterningTable.intern(value ?? '')
						propArrays[`${propName}_offset`].fill(offset, start, end)
						propArrays[`${propName}_length`].fill(length, start, end)
					} else if (repInfo?.type === 'array') {
						const { capacity, lengthProperty } = repInfo
						const sourceArray = value ?? []
						const liveLength = Math.min(sourceArray.length, capacity)
						for (let i = 0; i < capacity; i++) {
							const itemValue = i < liveLength ? sourceArray[i] || 0 : 0
							propArrays[`${propName}${i}`].fill(itemValue, start, end)
						}
						if (lengthProperty && propArrays[lengthProperty]) {
							propArrays[lengthProperty].fill(liveLength, start, end)
						}
					} else if (repInfo?.type === 'enum') {
						const { enumMap } = repInfo
						const intValue = (typeof value === 'string' ? enumMap[value] : value) ?? 0
						propArrays[propName].fill(intValue, start, end)
					} else if (propArrays[propName]) {
						propArrays[propName].fill(value ?? 0, start, end)
					}
				}
			}
		} else {
			const componentArray = data.componentArrays[componentTypeID]
			for (let i = start; i < end; i++) {
				const existingInstance = componentArray[i]
				if (existingInstance) {
					Object.assign(existingInstance, updateData)
				}
			}
		}
	}

	/**
	 * Private helper to update "Hot" component data from raw data object.
	 * @private
	 */
	_updateHotComponentDataFromRaw(archetypeId, entityIndex, rawData, info) {
		const data = this.archetypeData[archetypeId]
		const propArrays = data.componentArrays[info.typeID]
		if (!rawData) return

		for (const propName in rawData) {
			if (Object.prototype.hasOwnProperty.call(rawData, propName)) {
				const value = rawData[propName]
				const repInfo = info.representations[propName]

				if (repInfo?.type === 'string') {
					const { offset, length } = this.componentManager.stringInterningTable.intern(value ?? '')
					propArrays[`${propName}_offset`][entityIndex] = offset
					propArrays[`${propName}_length`][entityIndex] = length
				} else if (repInfo?.type === 'array') {
					const { capacity, lengthProperty } = repInfo
					const sourceArray = value ?? []
					const liveLength = Math.min(sourceArray.length, capacity)
					for (let i = 0; i < capacity; i++) {
						propArrays[`${propName}${i}`][entityIndex] = i < liveLength ? sourceArray[i] || 0 : 0
					}
					if (lengthProperty && propArrays[lengthProperty]) {
						propArrays[lengthProperty][entityIndex] = liveLength
					}
				} else if (repInfo?.type === 'enum') {
					const { enumMap } = repInfo
					propArrays[propName][entityIndex] = (typeof value === 'string' ? enumMap[value] : value) ?? 0
				} else if (propArrays[propName]) {
					propArrays[propName][entityIndex] = value ?? 0
				}
			}
		}
	}

	/**
	 * Private helper to fill "Hot" component data for a range of entities.
	 * This is optimized for batch operations using `TypedArray.fill()`.
	 * @private
	 */
	_fillHotComponentData(archetypeId, startIndex, endIndex, componentData, info, defaultInstance) {
		const data = this.archetypeData[archetypeId]
		const propArrays = data.componentArrays[info.typeID]

		for (const propName of info.originalSchemaKeys) {
			const repInfo = info.representations[propName]
			const valueToFill = componentData?.[propName] ?? defaultInstance[propName]

			if (repInfo?.type === 'string') {
				const { offset, length } = this.componentManager.stringInterningTable.intern(valueToFill ?? '')
				propArrays[`${propName}_offset`].fill(offset, startIndex, endIndex)
				propArrays[`${propName}_length`].fill(length, startIndex, endIndex)
			} else if (repInfo?.type === 'array') {
				const { capacity, lengthProperty } = repInfo
				const sourceArray = valueToFill ?? []
				const liveLength = Math.min(sourceArray.length, capacity)
				for (let itemIndex = 0; itemIndex < capacity; itemIndex++) {
					propArrays[`${propName}${itemIndex}`].fill(
						itemIndex < liveLength ? sourceArray[itemIndex] || 0 : 0,
						startIndex,
						endIndex
					)
				}
				if (lengthProperty && propArrays[lengthProperty]) {
					propArrays[lengthProperty].fill(liveLength, startIndex, endIndex)
				}
			} else if (propArrays[propName]) {
				propArrays[propName].fill(valueToFill ?? 0, startIndex, endIndex)
			}
		}
	}

	/**
	 * Private helper to update "Hot" component data, using defaults.
	 * @private
	 */
	_updateHotComponentData(archetypeId, entityIndex, componentData, info, defaultInstance) {
		const data = this.archetypeData[archetypeId]
		const propArrays = data.componentArrays[info.typeID]

		for (const propName of info.originalSchemaKeys) {
			const repInfo = info.representations[propName]

			if (repInfo?.type === 'string') {
				const stringValue = componentData?.[propName] ?? defaultInstance[propName] ?? ''
				const { offset, length } = this.componentManager.stringInterningTable.intern(stringValue)
				propArrays[`${propName}_offset`][entityIndex] = offset
				propArrays[`${propName}_length`][entityIndex] = length
			} else if (repInfo?.type === 'array') {
				const { capacity, lengthProperty } = repInfo
				const sourceArray = componentData?.[propName] ?? defaultInstance[propName] ?? []
				const liveLength = Math.min(sourceArray.length, capacity)
				for (let itemIndex = 0; itemIndex < capacity; itemIndex++) {
					propArrays[`${propName}${itemIndex}`][entityIndex] = itemIndex < liveLength ? sourceArray[itemIndex] || 0 : 0
				}
				if (lengthProperty && propArrays[lengthProperty]) {
					propArrays[lengthProperty][entityIndex] = liveLength
				}
			} else if (repInfo?.type === 'enum') {
				const { enumMap } = repInfo
				let value = componentData?.[propName] ?? defaultInstance[propName]
				propArrays[propName][entityIndex] = (typeof value === 'string' ? enumMap[value] : value) ?? 0
			} else if (propArrays[propName]) {
				propArrays[propName][entityIndex] = componentData?.[propName] ?? defaultInstance[propName] ?? 0
			}
		}
	}

	/**
	 * Updates the max dirty tick for a given archetype. This is designed to be
	 * called from within the Archetype class.
	 * @param {number} archetypeId - The internal ID of the archetype.
	 * @param {number} tick - The current tick.
	 * @internal
	 */
	updateArchetypeMaxTick(archetypeId, tick) {
		if (tick > this.archetypeMaxDirtyTicks[archetypeId]) {
			this.archetypeMaxDirtyTicks[archetypeId] = tick
		}
	}

	/**
	 * Moves multiple entities between archetypes in a batched operation.
	 * This is a core part of the CommandBuffer flush and is significantly more performant
	 * than moving entities one by one.
	 * @param {Map<number, Map<number, {entityIds: number[], componentsToAssignArrays: Map[]}>>>} moves - A nested map structuring the moves: `SourceArchetypeID -> TargetArchetypeID -> {entityIds, componentsToAssignArrays}`.
	 */
	moveEntitiesInBatch(moves) {
		const entityManager = theManager.getManager('EntityManager')
		const allRemovals = new Map() // Map<archetypeId, Set<number>> to store indices to remove.

		for (const [sourceArchetypeId, targets] of moves.entries()) {
			if (!allRemovals.has(sourceArchetypeId)) {
				allRemovals.set(sourceArchetypeId, new Set())
			}
			const indicesToRemove = allRemovals.get(sourceArchetypeId)

			for (const [targetArchetypeId, moveData] of targets.entries()) {
				const { entityIds, componentsToAssignArrays } = moveData
				if (entityIds.length === 0) continue

				// OPTIMIZATION: Instead of creating an array of objects, we now build a single array of source indices.
				// This avoids creating thousands of temporary objects during a large batch move.
				const sourceIndices = []
				for (const entityId of entityIds) {
					const sourceIndex = entityManager.entityIndexInArchetype[entityId]
					indicesToRemove.add(sourceIndex)
					sourceIndices.push(sourceIndex)
				}

				const newIndexMap = this.addEntitiesByCopyingBatch(
					targetArchetypeId,
					sourceArchetypeId,
					sourceIndices,
					entityIds,
					componentsToAssignArrays,
					this.systemManager.currentTick
				)

				// Update the central entity-to-archetype mappings.
				for (const [entityId, newIndex] of newIndexMap.entries()) {
					entityManager.entityArchetype[entityId] = targetArchetypeId
					entityManager.entityIndexInArchetype[entityId] = newIndex
				}
			}
		}

		for (const [archetypeId, indicesToRemove] of allRemovals.entries()) {
			if (indicesToRemove.size > 0) {
				const movedEntities = this.compactAndRemove(archetypeId, indicesToRemove)
				for (const [movedEntityId, newIndex] of movedEntities.entries()) {
					entityManager.entityIndexInArchetype[movedEntityId] = newIndex
				}
			}
		}
	}

	/**
	 * Adds a batch of entities by copying their data from a source archetype.
	 * @param {number} targetArchetypeId - The destination archetype ID.
	 * @param {number} sourceArchetypeId - The source archetype ID.
	 * @param {number[]} sourceIndices - The source indices of the entities to move.
	 * @param {number[]} entityIds - The IDs of the entities to move.
	 * @param {Map<number, object>[]} componentsToAssignArrays - The component data for each entity.
	 * @param {number} currentTick - The current system tick.
	 * @returns {Map<number, number>} A map of `entityId -> newIndex`.
	 */
	addEntitiesByCopyingBatch(
		targetArchetypeId,
		sourceArchetypeId,
		sourceIndices,
		entityIds,
		componentsToAssignArrays,
		currentTick
	) {
		const data = this.archetypeData[targetArchetypeId]
		const sourceData = this.archetypeData[sourceArchetypeId]
		const count = entityIds.length
		if (count === 0) return new Map()

		const newIndices = []
		const entityIdToNewIndex = new Map()

		const requiredCapacity = data.entityCount + count
		if (requiredCapacity > data.capacity) {
			this._resize(targetArchetypeId, Math.max(requiredCapacity, data.capacity * 2))
		}
		const startIndex = data.entityCount

		for (let i = 0; i < count; i++) {
			const newIndex = startIndex + i
			newIndices.push(newIndex)
			entityIdToNewIndex.set(entityIds[i], newIndex)
		}

		this.updateArchetypeMaxTick(targetArchetypeId, currentTick)

		let isContiguous = count > 0
		if (isContiguous) {
			const firstSourceIndex = sourceIndices[0]
			for (let i = 1; i < count; i++) {
				if (sourceIndices[i] !== firstSourceIndex + i) {
					isContiguous = false
					break
				}
			}
		}
		const firstSourceIndex = isContiguous ? sourceIndices[0] : -1

		// Correctly set the entity IDs for the new entities in the target archetype.
		data.entities.set(entityIds, startIndex)

		for (const typeID of data.hotComponentTypeIDs) {
			const info = this.componentManager.componentInfo[typeID]
			const dirtyTicksArray = data.dirtyTicksArrays[typeID]
			const sourceHasComponent = this.hasComponentType(sourceArchetypeId, typeID)
			const targetPropArrays = data.componentArrays[typeID]

			if (sourceHasComponent) {
				const sourcePropArrays = sourceData.componentArrays[typeID]
				for (const propKey of info.propertyKeys) {
					const targetArray = targetPropArrays[propKey]
					const sourceArray = sourcePropArrays[propKey]
					if (isContiguous) {
						targetArray.set(sourceArray.subarray(firstSourceIndex, firstSourceIndex + count), startIndex)
					} else {
						for (let i = 0; i < count; i++) {
							targetArray[startIndex + i] = sourceArray[sourceIndices[i]]
						}
					}
				}
			}

			let needsInitPass = !sourceHasComponent
			if (!needsInitPass) {
				for (let i = 0; i < count; i++) {
					if (componentsToAssignArrays[i].has(typeID)) {
						needsInitPass = true
						break
					}
				}
			}

			if (needsInitPass) {
				const defaultInstance = this.componentManager.getDefaultInstance(typeID)
				for (let i = 0; i < count; i++) {
					const componentsToAssign = componentsToAssignArrays[i]
					if (!sourceHasComponent || componentsToAssign.has(typeID)) {
						this._updateHotComponentData(
							targetArchetypeId,
							newIndices[i],
							componentsToAssign.get(typeID),
							info,
							defaultInstance
						)
					}
				}
			}
			dirtyTicksArray.fill(currentTick, startIndex, startIndex + count)
		}

		for (const typeID of data.coldComponentTypeIDs) {
			const dirtyTicksArray = data.dirtyTicksArrays[typeID]
			const sourceHasComponent = this.hasComponentType(sourceArchetypeId, typeID)
			const componentArray = data.componentArrays[typeID]
			const sourceComponentArray = sourceHasComponent ? sourceData.componentArrays[typeID] : undefined

			for (let i = 0; i < count; i++) {
				const newIndex = newIndices[i]
				const componentsToAssign = componentsToAssignArrays[i]
				if (!sourceHasComponent || componentsToAssign.has(typeID)) {
					const ComponentClass = this.componentManager.getComponentClassByTypeID(typeID)
					componentArray[newIndex] = this.componentManager.createComponentInstance(
						ComponentClass,
						componentsToAssign.get(typeID),
						entityIds[i]
					)
				} else {
					componentArray[newIndex] = sourceComponentArray[sourceIndices[i]]
				}
				dirtyTicksArray[newIndex] = currentTick
			}
		}

		data.entityCount += count
		return entityIdToNewIndex
	}

	/**
	 * Clears all entities from all archetypes and resets the manager.
	 * This is a more efficient way to destroy all entities than one by one.
	 */
	clearAll() {
		// Notify QueryManager that all archetypes are being deleted.
		for (const archetypeId of this.archetypeLookup.values()) {
			this.queryManager.unregisterArchetype(archetypeId)
		}

		// Clear all internal maps.
		this.archetypeLookup.clear()
		this.archetypeData.length = 0
	}
}

export const archetypeManager = new ArchetypeManager()
