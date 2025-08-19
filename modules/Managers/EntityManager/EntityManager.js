/**
 * @fileoverview Manages the lifecycle and location of all entities in the game world.
 *
 * ---
 *
 * ### Architectural Note: The Indirection Layer
 *
 * The `EntityManager` is the heart of the ECS's data lookup system. It doesn't store
 * any component data itself. Instead, it provides a crucial layer of indirection that
 * maps a sparse, stable `entityID` to the actual, densely packed component data stored
 * within an `Archetype`.
 *
 * This is achieved through two primary sparse arrays:
 *
 * 1.  `this.entityArchetype`: An array where `entityArchetype[entityID]` returns the
 *     `archetypeId` (a small integer) the entity belongs to.
 *
 * 2.  `this.entityIndexInArchetype`: An array where `entityIndexInArchetype[entityID]`
 *     returns the row index of that entity's data within its archetype's component arrays.
 *
 * #### Why this is so fast:
 *
 * - **Dense Component Storage:** Component data within an archetype is stored in tightly
 *   packed arrays (either SoA or AoS). This is essential for cache-friendly iteration,
 *   which is the primary source of performance in an ECS.
 *
 * - **Stable Entity IDs:** Entity IDs can be created and destroyed frequently. They can be
 *   recycled, leading to a sparse set of active IDs. The indirection layer means we don't
 *   have to care about the sparseness of IDs when iterating over components.
 *
 * - **Efficient Structural Changes:** When an entity is moved between archetypes (e.g., by
 *   adding or removing a component), or when an entity is destroyed, we use a "swap-and-pop"
 *   (or compaction for batches) technique within the archetype. This keeps the component
 *   arrays dense. The only thing that needs to be updated for the moved entities is their
 *   `entityIndexInArchetype` value. The `EntityManager`'s indirection makes this O(1)
 *   update possible, avoiding costly data shifting.
 *
 * **Example Lookup Flow:**
 *
 * `entityID` -> `EntityManager.entityArchetype[entityID]` -> `archetypeId`
 *            -> `EntityManager.entityIndexInArchetype[entityID]` -> `index`
 *
 * ...then `ArchetypeManager.getData(archetypeId).componentArrays[typeID].x[index]` to get the data.
 */
const { systemManager } = await import(`${PATH_MANAGERS}/SystemManager/SystemManager.js`)

const { LRUCache } = await import(`${PATH_CORE}/DataStructures/LRUCache.js`)
const { SoAComponentView } = await import(`${PATH_MANAGERS}/ArchetypeManager/Views.js`)

export class EntityManager {
	/**
	 * @property {number} nextEntityID - The next available entity ID to be assigned if no recycled IDs are available.
	 * @property {number[]} freeIDs - A stack (implemented as an array) to store IDs of destroyed entities that can be recycled.
	 * @property {Set<number>} activeEntities - A set to keep track of all currently active (alive) entity IDs, allowing for quick checks if an entity ID is valid and in use.
	 */
	constructor() {
		this.nextEntityID = 1 // Start IDs from 1. 0 is reserved for "null" or "empty".
		this.freeIDs = []
		this.activeEntities = new Set()

		/**
		 * A sparse array mapping an entity ID to the internal ID of the Archetype it currently belongs to.
		 * `entityArchetype[entityID] = archetypeId`.
		 * This provides O(1) lookup.
		 * @type {Array<number | undefined>}
		 */
		this.entityArchetype = []

		/**
		 * A sparse array mapping an entity ID to its index within its archetype's arrays.
		 * `entityIndexInArchetype[entityID] = index`.
		 * @type {Array<number | undefined>}
		 */
		this.entityIndexInArchetype = []
	}

	async init() {
		this.archetypeManager = (await import(`${PATH_MANAGERS}/ArchetypeManager/ArchetypeManager.js`)).archetypeManager
		this.componentManager = (await import(`${PATH_MANAGERS}/ComponentManager/ComponentManager.js`)).componentManager // Keep for createEntity
		this.prefabManager = (await import(`${PATH_MANAGERS}/PrefabManager/PrefabManager.js`)).prefabManager
		this.systemManager = (await import(`${PATH_MANAGERS}/SystemManager/SystemManager.js`)).systemManager
	}

	/**
	 * The absolute fastest path for creating an entity with a pre-defined set of components using their type IDs.
	 * This method avoids all lookups and is the preferred path for the CommandBuffer flush.
	 *
	 * @param {Map<number, object>} componentIdMap - A map where keys are componentTypeIDs and values are their data.
	 * @returns {number | undefined} The ID of the newly created entity, or undefined on failure.
	 * @private
	 */
	createEntityWithComponentsByIds(componentIdMap) {
		if (componentIdMap.size === 0) {
			return this._createEntityID()
		}

		const entityID = this._createEntityID()
		const targetComponentTypeIDs = Array.from(componentIdMap.keys())

		const oldArchetypeId = this.entityArchetype[entityID] // Will be undefined for new entities
		const newArchetypeId = this.archetypeManager.getArchetype(targetComponentTypeIDs)

		if (oldArchetypeId !== undefined) {
			// This path should not be hit by createEntity, which is for new entities.
			// It's here for completeness if this method is ever used for updates.
			this._moveEntityBetweenArchetypes(entityID, oldArchetypeId, newArchetypeId, componentIdMap)
		} else {
			// This is the path for NEW entities.
			const newIndex = this.archetypeManager.addEntity(newArchetypeId, entityID, componentIdMap, this.systemManager.currentTick)
			this.entityArchetype[entityID] = newArchetypeId
			this.entityIndexInArchetype[entityID] = newIndex
		}

		return entityID
	}

	/**
	 * The absolute fastest path for creating multiple entities in a known archetype.
	 * This is called by the CommandBuffer after it has grouped creations.
	 * @param {number} archetypeId - The internal ID of the archetype to add entities to. * @param {Array<Map<number, object>>} componentsDataMaps - An array of component data maps, where each map corresponds to an entity.
	 * @returns {number[]} An array of the newly created entity IDs.
	 * @internal
	 */
	createEntitiesInArchetype(archetypeId, componentsDataMaps) {
		if (archetypeId === undefined || !Array.isArray(componentsDataMaps) || componentsDataMaps.length === 0) {
			return []
		}

		const entityIDs = []
		for (let i = 0; i < componentsDataMaps.length; i++) {
			entityIDs.push(this._createEntityID())
		}

		const startIndex = this.archetypeManager.addEntitiesBatch(archetypeId, entityIDs, componentsDataMaps, this.systemManager.currentTick)
		for (let i = 0; i < entityIDs.length; i++) {
			const entityID = entityIDs[i]
			this.entityArchetype[entityID] = archetypeId
			this.entityIndexInArchetype[entityID] = startIndex + i
		}

		return entityIDs
	}

	/**
	 * The absolute fastest path for creating multiple identical entities in a known archetype.
	 * This is called by the CommandBuffer for the `createEntities` command.
	 * @param {number} archetypeId - The internal ID of the archetype to add entities to.
	 * @param {Map<number, object>} componentIdMap - The single component data map for all entities.
	 * @param {number} count - The number of entities to create.
	 * @returns {number[]} An array of the newly created entity IDs.
	 * @internal
	 */
	createIdenticalEntitiesInArchetype(archetypeId, componentIdMap, count) {
		if (archetypeId === undefined || count <= 0) {
			return []
		}

		const entityIDs = []
		for (let i = 0; i < count; i++) {
			entityIDs.push(this._createEntityID())
		}

		const startIndex = this.archetypeManager.addIdenticalEntitiesBatch(archetypeId, entityIDs, componentIdMap, this.systemManager.currentTick)
		for (let i = 0; i < entityIDs.length; i++) {
			const entityID = entityIDs[i]
			this.entityArchetype[entityID] = archetypeId
			this.entityIndexInArchetype[entityID] = startIndex + i
		}

		return entityIDs
	}

	/**
	 * The high-performance, low-level method for creating an entity with a pre-defined set of components.
	 * This method avoids all string lookups and is the preferred path for performance-critical code
	 * like the CommandBuffer flush.
	 *
	 * @param {Map<Function, object>} componentMap - A map where keys are Component Classes and values are their data.
	 * @returns {number | undefined} The ID of the newly created entity, or undefined on failure.
	 */
	createEntityWithComponents(componentMap) {
		// This is now a convenience wrapper that converts the class map to an ID map
		// before calling the true high-performance method.
		const componentIdMap = new Map()
		for (const [ComponentClass, componentData] of componentMap.entries()) {
			const typeID = this.componentManager.getComponentTypeID(ComponentClass)
			if (typeID !== undefined) {
				componentIdMap.set(typeID, componentData)
			} else {
				console.warn(`EntityManager: Component ${ComponentClass.name} is not registered. Skipping.`)
			}
		}
		return this.createEntityWithComponentsByIds(componentIdMap)
	}

	/**
	 * A private helper to convert a string-keyed component data object to a typeID-keyed map.
	 * @param {object} componentsInput - An object like `{ Position: { x: 10 }, Velocity: { y: 5 } }`.
	 * @returns {Map<number, object>} A map where keys are componentTypeIDs.
	 * @private
	 */
	_convertComponentDataToIdMap(componentsInput) {
		const componentIdMap = new Map()
		if (!componentsInput) return componentIdMap

		for (const componentName in componentsInput) {
			if (Object.prototype.hasOwnProperty.call(componentsInput, componentName)) {
				const ComponentClass = this.componentManager.getComponentClassByName(componentName)
				if (ComponentClass) {
					const typeID = this.componentManager.getComponentTypeID(ComponentClass)
					if (typeID !== undefined) {
						componentIdMap.set(typeID, componentsInput[componentName])
					}
				} else {
					console.warn(`EntityManager: Component class for name "${componentName}" not found. It will be skipped.`)
				}
			}
		}
		return componentIdMap
	}

	/**
	 * Creates a new entity. If componentsInput is provided, it assigns those components to the new entity.
	 * If no componentsInput is provided or the object is empty, an empty entity is created.
	 *
	 * @warning For performance-critical code inside systems, you should always use the
	 * `CommandBuffer` (`commands.createEntity()`) to defer structural changes. This method
	 * performs an immediate, more costly operation.
	 *
	 * @param {object} [componentsInput={}] - An object where keys are component string names
	 *   and values are the data objects for constructing these components.
	 *   Example: { Sprite: { assetName: 'player' }, Speed: { value: 100 } }
	 * @returns {number | undefined} The ID of the newly created entity, or undefined if entity creation fails.
	 */
	createEntity(componentsInput = {}) {
		const componentIdMap = this._convertComponentDataToIdMap(componentsInput)
		return this.createEntityWithComponentsByIds(componentIdMap)
	}

	/**
	 * Synchronously creates an entity from a data-driven prefab. This is the primary method
	 * for creating entities from templates outside of a system's update loop.
	 *
	 * For deferred creation from within a system, use `commands.instantiate()`.
	 *
	 * @warning This method will fail if the prefab for `prefabId` has not been pre-loaded.
	 * @param {string} prefabId - The ID of the prefab from the manifest (e.g., 'player_character', 'fireball').
	 * @param {object} [overrides={}] - An object of component data to override the prefab's defaults.
	 * @param {object} [options={}] - Optional parameters for creation.
	 * @param {number|null} [options.parentId=null] - The parent entity ID for the root of the prefab.
	 * @param {number|null} [options.ownerId=null] - The owner entity ID for the root of the prefab.
	 * @returns {number|undefined} The ID of the created entity.
	 */
	instantiate(prefabId, overrides = {}, { parentId = null, ownerId = null } = {}) {
		const prefabData = this.prefabManager.getPrefabDataSync(prefabId)
		if (!prefabData) {
			console.error(
				`EntityManager: Failed to sync-instantiate entity. Prefab '${prefabId}' is not pre-loaded or registered in the manifest.`
			)
			return undefined
		}
		// Data-driven path
		return this._instantiateChildRecursive(prefabData, { rootPrefabName: prefabId, overrides, parentId, ownerId })
	}

	/**
	 * Creates a batch of entities from a data-driven prefab. This is significantly
	 * more performant than calling `instantiate` in a loop.
	 *
	 * For deferred creation from within a system, use `commands.instantiateBatch()`.
	 *
	 * @param {string} prefabId - The ID of the data-driven prefab.
	 * @param {number} count - The number of instances to create.
	 * @param {object} [options] - Optional parameters.
	 * @param {object} [options.overrides={}] - Component data to override defaults on the root entities.
	 * @returns {number[]} An array of the created root entity IDs.
	 */
	instantiateBatch(prefabId, count, { overrides = {} } = {}) {
		// For immediate-mode calls (i.e., from outside a system), we delegate directly
		// to the CommandBuffer's internal execution logic. This keeps the complex
		// implementation in a single, authoritative place (`CommandBuffer`) while still
		// allowing the EntityManager to serve as the clean, synchronous public API.
		// The CommandBuffer is retrieved via the SystemManager.
		return this.systemManager.commandBuffer._executeInstantiateBatch(prefabId, count, { overrides })
	}

	/**
	 * Creates a batch of entities, each with its own specified component data.
	 * This is the most flexible and performant method for creating many potentially
	 * heterogeneous entities at once (e.g., creating 100 child entities, each with a
	 * different owner).
	 *
	 * For deferred creation from within a system, use `commands.createEntitiesWithData()`.
	 *
	 * @param {Array<object>} creationData - An array where each element is an object
	 *   representing the component data for one entity.
	 *   Example: `[{ Position: {x:1}, Owner:{id:10} }, { Position: {x:5}, Owner:{id:11} }]`
	 * @returns {number[]} An array of the created entity IDs, in the same order as the input data.
	 */
	createEntitiesWithData(creationData) {
		if (!creationData || creationData.length === 0) {
			return []
		}
		return this.systemManager.commandBuffer._executeCreateEntitiesWithData(creationData)
	}

	/**
	 * Private helper to recursively create an entity and its children from prefab data.
	 * This is the core logic for both sync and async instantiation.
	 * @param {object} prefabData - The raw data for the entity to create.
	 * @param {object} options - Creation options.
	 * @private
	 */
	_instantiateChildRecursive(
		prefabData,
		{ rootPrefabName = null, overrides = {}, parentId = null, ownerId = null } = {}
	) {
		const isRoot = rootPrefabName !== null
		const componentData = { ...prefabData.components }

		// Apply overrides and special components only to the root of the prefab graph.
		if (isRoot) {
			Object.assign(componentData, overrides)
			componentData.PrefabId = { id: rootPrefabName }
		}

		if (parentId) componentData.Parent = { entityId: parentId }
		if (ownerId) componentData.Owner = { entityId: ownerId }

		// Use the internal, high-performance `createEntity` method.
		const entityId = this.createEntity(componentData)
		if (entityId === undefined) return undefined // Creation failed.

		// The owner of any children is either the explicit owner passed in, or the root entity being created.
		const childrenOwnerId = ownerId || entityId

		if (prefabData.children && prefabData.children.length > 0) {
			for (const childData of prefabData.children) {
				// Recursively call, passing down parent and owner context. Overrides do not apply to children.
				this._instantiateChildRecursive(childData, { parentId: entityId, ownerId: childrenOwnerId })
			}
		}
		return entityId
	}

	/**
	 * Updates the data of an existing component on an entity.
	 * This is a high-level, "safe" method that performs all necessary lookups.
	 * It will fail if the entity does not already have the component.
	 *
	 * @warning For performance-critical code inside systems, you should always use the
	 * `CommandBuffer` (`commands.setComponentData()`) to defer structural changes.
	 * @param {number} entityID - The ID of the entity.
	 * @param {Function} ComponentClass - The component class constructor.
	 * @param {object} componentData - The new data for the component.
	 * @returns {boolean} True if the component was successfully updated, false otherwise.
	 */
	setComponentData(entityID, ComponentClass, componentData) {
		if (!this.isEntityActive(entityID)) {
			console.warn(`EntityManager: Cannot set component data for inactive or non-existent entity ${entityID}.`)
			return false
		}

		const componentTypeID = this.componentManager.getComponentTypeID(ComponentClass)
		if (componentTypeID === undefined) {
			console.warn(
				`EntityManager: Component type ${ComponentClass.name} is not registered. Cannot set data for entity ${entityID}.`
			)
			return false
		}

		const archetypeId = this.entityArchetype[entityID]

		if (archetypeId === undefined || !this.archetypeManager.hasComponentType(archetypeId, componentTypeID)) {
			const componentName = this.componentManager.getComponentNameByTypeID(componentTypeID)
			console.error(
				`EntityManager: Cannot set data for component '${componentName}' on entity ${entityID}. The entity does not have this component.`
			)
			return false
		}

		const entityIndex = this.entityIndexInArchetype[entityID]
		if (entityIndex !== undefined) {
			// Use the correct batch-update method, wrapping the single update in an array.
			this.archetypeManager.setEntitiesComponents(
				archetypeId,
				[{ entityIndex: entityIndex, componentsToUpdate: new Map([[componentTypeID, componentData]]) }],
				this.systemManager.currentTick
			)
			return true
		}
		return false
	}

	/**
	 * Adds a component to an existing entity or updates it if it already exists.
	 * This is a high-level, "safe" method that performs all necessary lookups.
	 *
	 * @warning For performance-critical code inside systems, you should always use the
	 * `CommandBuffer` (`commands.addComponent()`) to defer structural changes. This method
	 * performs an immediate, more costly operation.
	 * @param {number} entityID - The ID of the entity.
	 * @param {Function} ComponentClass - The component class constructor.
	 * @param {object} [componentData] - Optional data to initialize or update the component.
	 * @returns {boolean} True if the component was successfully added or updated, false otherwise.
	 */
	addComponent(entityID, ComponentClass, componentData) {
		if (!this.isEntityActive(entityID)) {
			console.warn(`EntityManager: Cannot add component to inactive or non-existent entity ${entityID}.`)
			return false
		}

		const newComponentTypeID = this.componentManager.getComponentTypeID(ComponentClass)
		if (newComponentTypeID === undefined) {
			console.warn(
				`EntityManager: Component type ${ComponentClass.name} is not registered. Cannot add to entity ${entityID}.`
			)
			return false
		}

		const currentArchetypeId = this.entityArchetype[entityID]

		if (currentArchetypeId === undefined) {
			// Entity has no archetype yet.
			const newArchetypeId = this.archetypeManager.getArchetype([newComponentTypeID])
			const newIndex = this.archetypeManager.addEntity(
				newArchetypeId,
				entityID,
				new Map([[newComponentTypeID, componentData]]),
				this.systemManager.currentTick
			)
			this.entityArchetype[entityID] = newArchetypeId
			this.entityIndexInArchetype[entityID] = newIndex
			return true
		}

		if (this.archetypeManager.hasComponentType(currentArchetypeId, newComponentTypeID)) {
			console.warn(
				`EntityManager: Entity ${entityID} already has component '${this.componentManager.getComponentNameByTypeID(
					newComponentTypeID
				)}'. Use setComponentData to update.`
			)
			return false
		}
		const currentArchetype = this.archetypeManager.getData(currentArchetypeId)
		// Find or create the target archetype and cache it in the source archetype.
		let targetArchetypeId = currentArchetype.transitions.add[newComponentTypeID]
		if (targetArchetypeId === undefined) {
			const newTypeIDs = [...this.archetypeManager.getData(currentArchetypeId).componentTypeIDs, newComponentTypeID]
			targetArchetypeId = this.archetypeManager.getArchetype(newTypeIDs)
			currentArchetype.transitions.add[newComponentTypeID] = targetArchetypeId
		}

		this._moveEntityBetweenArchetypes(
			entityID,
			currentArchetypeId,
			targetArchetypeId,
			new Map([[newComponentTypeID, componentData]])
		)
		return true
	}

	/**
	 * Removes a component from an entity.
	 * This is a high-level, "safe" method that performs all necessary lookups and causes
	 * an immediate structural change.
	 *
	 * @warning For performance-critical code inside systems, you should always use the
	 * `CommandBuffer` (`commands.removeComponent()`) to defer structural changes.
	 * @param {number} entityID - The ID of the entity.
	 * @param {Function} ComponentClass - The component class constructor to remove.
	 * @returns {boolean} True if the component was successfully removed, false otherwise.
	 */
	removeComponent(entityID, ComponentClass) {
		if (!this.isEntityActive(entityID)) {
			console.warn(`EntityManager: Cannot remove component from inactive or non-existent entity ${entityID}.`)
			return false
		}

		const componentTypeIDToRemove = this.componentManager.getComponentTypeID(ComponentClass)
		if (componentTypeIDToRemove === undefined) {
			console.warn(`EntityManager: Component type ${ComponentClass.name} is not registered. Cannot remove.`)
			return false
		}

		const currentArchetypeId = this.entityArchetype[entityID]
		if (currentArchetypeId === undefined || !this.archetypeManager.hasComponentType(currentArchetypeId, componentTypeIDToRemove)) {
			return false
		}
		const currentArchetype = this.archetypeManager.getData(currentArchetypeId)
		// Check the archetype's transition cache first.
		let targetArchetypeId = currentArchetype.transitions.remove[componentTypeIDToRemove]
		if (targetArchetypeId === undefined) {
			// Cache miss: find or create the target archetype once and cache it.
			const newTypeIDs = [...this.archetypeManager.getData(currentArchetypeId).componentTypeIDs].filter(id => id !== componentTypeIDToRemove)
			targetArchetypeId = this.archetypeManager.getArchetype(newTypeIDs)
			currentArchetype.transitions.remove[componentTypeIDToRemove] = targetArchetypeId
		}

		this._moveEntityBetweenArchetypes(entityID, currentArchetypeId, targetArchetypeId, new Map())
		return true
	}

	/**
	 * Retrieves a component instance from an entity.
	 * This is a high-level, "safe" method that performs all necessary lookups.
	 *
	 * For "Hot" (Struct-of-Arrays) components, this method constructs a new component instance from the
	 * underlying data. This provides a safe, intuitive, and consistent API, but it does involve a small
	 * performance cost due to object allocation. For performance-critical code inside system loops,
	 * you should always use the high-performance `archetype.getComponentAccessor()` method instead.
	 * "Cold" (object-based)
	 * components return a direct, mutable reference.
	 *
	 * @param {number} entityID - The ID of the entity.
	 * @param {Function} ComponentClass - The component class constructor.
	 * @returns {object | undefined} The component instance (or a read-only view for Hot components), or undefined if not found.
	 */
	getComponent(entityID, ComponentClass) {
		if (!this.isEntityActive(entityID)) return undefined

		const componentTypeID = this.componentManager.getComponentTypeID(ComponentClass)
		if (componentTypeID === undefined) return undefined

		const archetypeId = this.entityArchetype[entityID]
		const entityIndex = this.entityIndexInArchetype[entityID]

		if (archetypeId !== undefined && entityIndex !== undefined && this.archetypeManager.hasComponentType(archetypeId, componentTypeID)) {
			const archetypeData = this.archetypeManager.getData(archetypeId)
			const info = this.componentManager.componentInfo[componentTypeID]

			if (info.storage === 'Hot') {
				// For "Hot" (SoA) components, we use the archetype's cached accessor to get a flyweight
				// view of the data, then we construct a new component instance from that view.
				// This is the "friendly path" and allocates, so it's not for hot loops. It's now more
				// efficient as it avoids allocating a new SoAComponentView on every call.
				const accessor = this.archetypeManager.getComponentAccessor(archetypeId, componentTypeID)
				const view = accessor.get(entityIndex) // This is the cached, flyweight view

				const newInstance = new ComponentClass() // Create a fresh instance
				for (const propName of info.originalSchemaKeys) {
					// The view's property getter will return either a primitive or another flyweight
					// view (e.g., InternedStringView). We assign this directly to the new instance.
					newInstance[propName] = view[propName]
				}
				return newInstance
			}
			// For 'Cold' data, we return the direct object reference as before.
			const coldComponentArray = archetypeData.componentArrays[componentTypeID]
			return coldComponentArray ? coldComponentArray[entityIndex] : undefined
		}
		return undefined
	}

	/**
	 * Checks if an entity has a specific component.
	 * This is a high-level, "safe" method that performs all necessary lookups.
	 *
	 * For performance-critical checks within systems, use the low-level path:
	 * `archetypeManager.getArchetypeForEntity(id).hasComponentType(typeID)`
	 * @param {number} entityID - The ID of the entity.
	 * @param {Function} ComponentClass - The component class constructor.
	 * @returns {boolean} True if the entity has the component, false otherwise.
	 */
	hasComponent(entityID, ComponentClass) {
		if (!this.isEntityActive(entityID)) return false
		if (!ComponentClass) return false

		const componentTypeID = this.componentManager.getComponentTypeID(ComponentClass)
		if (componentTypeID === undefined) return false

		const archetypeId = this.entityArchetype[entityID]
		return archetypeId !== undefined ? this.archetypeManager.hasComponentType(archetypeId, componentTypeID) : false
	}

	/**
	 * Creates a new entity ID or recycles an old one.
	 * @returns {number} The ID of the created or recycled entity.
	 * @throws {Error} If no more entity IDs can be generated (e.g., if a maxEntities limit is reached and no IDs are free).
	 * @private
	 */
	_createEntityID() {
		let entityID

		if (this.freeIDs.length > 0) {
			entityID = this.freeIDs.pop()
		} else {
			entityID = this.nextEntityID
			this.nextEntityID++
		}

		this.activeEntities.add(entityID)

		return entityID
	}

	/**
	 * Destroys an entity, making its ID available for recycling.
	 *
	 * @warning For performance-critical code inside systems, you should always use the
	 * `CommandBuffer` (`commands.destroyEntity()`) to defer structural changes. This method
	 * performs an immediate, more costly operation.
	 * @param {number} entityID The ID of the entity to destroy.
	 * @returns {boolean} True if the entity was active and successfully marked for destruction, false otherwise.
	 */
	destroyEntity(entityID) {
		if (!this.activeEntities.has(entityID)) {
			console.warn(`EntityManager: Entity ${entityID} is not active or does not exist. Cannot destroy.`)
			return false
		}

		const archetypeId = this.entityArchetype[entityID]
		if (archetypeId !== undefined) {
			const indexToRemove = this.entityIndexInArchetype[entityID]
			const swappedEntityId = this.archetypeManager.removeEntityAtIndex(archetypeId, indexToRemove)

			if (swappedEntityId !== undefined) {
				this.entityIndexInArchetype[swappedEntityId] = indexToRemove
			}
		} else {
			console.warn(`EntityManager: destroyEntity called for entity ${entityID} which has no archetype mapping.`)
		}

		// Clear the destroyed entity's entries from the sparse arrays.
		this.entityArchetype[entityID] = undefined
		this.entityIndexInArchetype[entityID] = undefined

		this.activeEntities.delete(entityID)
		this.freeIDs.push(entityID)

		return true
	}

	/**
	 * Destroys multiple entities in a single, batched operation.
	 * This is the high-performance path used by the CommandBuffer.
	 * @param {Set<number>} entityIDs - A set of entity IDs to destroy.
	 * @returns {boolean} True if the operation was successful.
	 */
	destroyEntitiesInBatch(entityIDs) {
		if (!entityIDs || entityIDs.size === 0) {
			return true
		}

		const entitiesByArchetype = new Map()

		// First, update the EntityManager's state and group entities by archetype in a single pass.
		for (const entityId of entityIDs) {
			// Only process active entities. This also handles cases where an ID is in the set multiple times.
			if (this.activeEntities.delete(entityId)) {
				this.freeIDs.push(entityId) // Recycle the ID
				const archetypeId = this.entityArchetype[entityId]
				if (archetypeId !== undefined) {
					if (!entitiesByArchetype.has(archetypeId)) {
						entitiesByArchetype.set(archetypeId, new Set())
					}
					entitiesByArchetype.get(archetypeId).add(this.entityIndexInArchetype[entityId])
				}
				// Clear the destroyed entity's entries from the sparse arrays.
				this.entityArchetype[entityId] = undefined
				this.entityIndexInArchetype[entityId] = undefined
			}
		}

		// Now, perform the expensive data moves (compaction) on the archetypes.
		for (const [archetypeId, indicesToRemove] of entitiesByArchetype.entries()) {
			const movedEntities = this.archetypeManager.compactAndRemove(archetypeId, indicesToRemove)
			for (const [movedEntityId, newIndex] of movedEntities.entries()) {
				this.entityIndexInArchetype[movedEntityId] = newIndex
			}
		}
		return true
	}

	/**
	 * Destroys all active entities and resets the manager to its initial state.
	 * This is a high-performance method suitable for clearing the game world, for example, when loading a new level.
	 */
	destroyAllEntities() {
		// Notify the ArchetypeManager to efficiently clear all entity data and archetypes.
		// This is much faster than destroying entities one by one.
		if (this.archetypeManager) {
			this.archetypeManager.clearAll()
		}

		// Reset the state of the EntityManager itself.
		this.activeEntities.clear()
		this.freeIDs = []
		this.nextEntityID = 1
		this.entityArchetype = []
		this.entityIndexInArchetype = []
	}

	/**
	 * Checks if an entity ID is currently active (i.e., has been created and not yet destroyed).
	 * @param {number} entityID The entity ID to check.
	 * @returns {boolean} True if the entity is active, false otherwise.
	 */
	isEntityActive(entityID) {
		return this.activeEntities.has(entityID)
	}

	/**
	 * A private helper that centralizes the logic for moving an entity between archetypes.
	 * @param {number} entityID The ID of the entity being moved.
	 * @param {number} oldArchetypeId The source archetype ID.
	 * @param {number} newArchetypeId The destination archetype ID.
	 * @param {Map<number, object>} componentsToAssignMap A map of componentTypeID to raw component data for the new archetype.
	 * @private
	 */
	_moveEntityBetweenArchetypes(entityID, oldArchetypeId, newArchetypeId, componentsToAssignMap) {
		const oldIndex = this.entityIndexInArchetype[entityID]

		let newIndex
		if (componentsToAssignMap.size === 0) {
			newIndex = this.archetypeManager.addEntityByCopying(newArchetypeId, entityID, oldArchetypeId, oldIndex, this.systemManager.currentTick)
		} else {
			newIndex = this.archetypeManager.addEntityWithNewData(
				newArchetypeId,
				entityID,
				oldArchetypeId,
				oldIndex,
				this.systemManager.currentTick,
				componentsToAssignMap
			)
		}

		this.entityArchetype[entityID] = newArchetypeId
		this.entityIndexInArchetype[entityID] = newIndex

		const swappedEntityId = this.archetypeManager.removeEntityAtIndex(oldArchetypeId, oldIndex)

		if (swappedEntityId !== undefined) {
			this.entityIndexInArchetype[swappedEntityId] = oldIndex
		}
	}
}

export const entityManager = new EntityManager()
