const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { Entity } = await import(`${PATH_MANAGERS}/EntityManager/Entity.js`)
const { componentInterpreter } = await import(`${PATH_MANAGERS}/ComponentManager/ComponentInterpreter.js`)

const { entityManager, componentManager, prefabManager, sharedGroupManager } = theManager.getManagers()

export const ECS = {

	// --- Immediate-Mode Public API ---
	// These methods provide a clean, high-level interface for interacting with the ECS
	// from outside of a system's update loop (e.g., for setup, one-off events, or testing).
	//
	// ### Deferred vs. Immediate Mode
	//
	// - **Immediate Mode (this API):** Use these methods for one-off actions. They execute
	//   immediately and are more costly.
	// - **Deferred Mode (`commands`):** Inside a system's `update` loop, you should **always**
	//   use the `commands` object (the CommandBuffer) to queue structural changes. This is vastly more performant.

	/**
	 * Returns a wrapper object for a given entity ID.
	 * This is intended for debugging and inspection, not for performance-critical code.
	 * @param {number} entityID The ID of the entity to wrap.
	 * @param {object} [options] - Options for the entity wrapper.
	 * @returns {Promise<import('../../Managers/EntityManager/Entity.js').Entity | null>} A Promise that resolves to an Entity wrapper instance, or null if the entity is not active.
	 */
	getEntity(entityID) {
		// Dynamically import the Entity class only when needed for debugging.
		// This keeps it out of the main bundle path and clarifies its purpose.

		if (!entityManager.isEntityActive(entityID)) {
			console.warn(`ECS.getEntity: Cannot get wrapper for inactive entity ID: ${entityID}`)
			return null
		}
		return new Entity(entityID)
	},

	/**
	 * Retrieves a manager instance by its name.
	 * This is a convenience method for console debugging.
	 * @param {string} managerName - The name of the manager (e.g., 'componentManager' or 'ComponentManager').
	 * @returns {object | undefined} The manager instance, or undefined if not found.
	 */
	getManager(managerName) {
		if (typeof managerName !== 'string' || !managerName) {
			console.error('ECS.getManager: A non-empty string is required for managerName.')
			return
		}

		// Allow for both 'componentManager' and 'ComponentManager' by ensuring PascalCase.
		const className = managerName.charAt(0).toUpperCase() + managerName.slice(1)
		const manager = theManager.getManager(className)

		if (!manager) {
			console.warn(`ECS.getManager: Manager "${className}" not found. Available managers:`, [
				...theManager.managers.keys(),
			])
		}
		return manager
	},

	/**
	 * Gets the current number of active entities.
	 * @returns {number} The number of active entities.
	 */
	getEntityCount() {
		return entityManager.activeEntities.size
	},

	/**
	 * Creates an entity immediately.
	 * @param {object} [componentsInput={}] - e.g., `{ Position: { x: 10 }, Velocity: { y: 5 } }`
	 * @returns {number|undefined} The new entity's ID.
	 */
	createEntity(componentsInput = {}) {
		if (Object.keys(componentsInput).length === 0) {
			return entityManager.createEntity()
		}
		const componentIdMap = componentManager.createIdMapFromData(componentsInput);
		return entityManager.createEntityWithComponentsByIds(componentIdMap)
	},

	/**
	 * Destroys an entity immediately.
	 * @param {number} entityId The ID of the entity to destroy.
	 * @returns {boolean} True if the entity was active and destroyed.
	 */
	destroyEntity(entityId) {
		return entityManager.destroyEntity(entityId)
	},

	/**
	 * Instantiates an entity from a prefab immediately.
	 * @param {string} prefabId The ID of the prefab.
	 * @param {object} [overrides={}] Component data to override prefab defaults.
	 * @returns {number|undefined} The new root entity's ID.
	 */
	instantiate(prefabId, overrides = {}, { parentId = null, ownerId = null } = {}) {
		const prefabData = prefabManager.getPrefabData(prefabId)
		if (!prefabData) {
			console.error(
				`ECS: Failed to sync-instantiate entity. Prefab '${prefabId}' is not pre-loaded or registered in the manifest.`
			)
			return undefined
		}
		return this._instantiateChildRecursive(prefabData, { rootPrefabName: prefabId, overrides, parentId, ownerId });
	},

	/**
	 * Checks if an entity is active.
	 * @param {number} entityId The entity ID.
	 * @returns {boolean}
	 */
	isEntityActive(entityId) {
		return entityManager.isEntityActive(entityId)
	},

	/**
	 * Adds a component to an entity immediately.
	 * @param {number} entityId The entity ID.
	 * @param {Function} ComponentClass The component class.
	 * @param {object} [data] The component's initial data.
	 * @returns {boolean} True on success.
	 */
	addComponent(entityId, ComponentClass, data) {
		const componentTypeId = componentManager.getComponentTypeID(ComponentClass)
		if (componentTypeId === undefined) {
			console.warn(`ECS.addComponent: Component "${ComponentClass.name}" not registered.`)
			return false
		}
		return entityManager.addComponent(entityId, componentTypeId, data)
	},

	/**
	 * Removes a component from an entity immediately.
	 * @param {number} entityId The entity ID.
	 * @param {Function} ComponentClass The component class.
	 * @returns {boolean} True on success.
	 */
	removeComponent(entityId, ComponentClass) {
		const componentTypeId = componentManager.getComponentTypeID(ComponentClass)
		if (componentTypeId === undefined) {
			// No need to warn, the component isn't even registered in the system.
			return false
		}
		return entityManager.removeComponent(entityId, componentTypeId)
	},

	/**
	 * Gets a component's data from an entity.
	 * @param {number} entityId The entity ID.
	 * @param {Function} ComponentClass The component class.
	 * @returns {object|undefined} The component data instance.
	 */
	getComponent(entityId, ComponentClass) {
		const componentTypeId = componentManager.getComponentTypeID(ComponentClass)
		if (componentTypeId === undefined) {
			// Component isn't registered, so no entity can have it.
			return undefined
		}
		const archetype = entityManager.getArchetypeForEntity(entityId)
		if (archetype === undefined || !componentManager.hasComponent(archetype, componentTypeId)) {
			return undefined
		}

		const perEntityData = componentInterpreter.read(entityId, componentTypeId, archetype)

		// Check for and merge shared data
		if (perEntityData && perEntityData.hasOwnProperty('groupId')) {
			const groupId = perEntityData.groupId
			const sharedGroup = sharedGroupManager.groups[groupId]
			const sharedComponentData = sharedGroup ? sharedGroup[componentTypeId] : null
			return { ...perEntityData, ...sharedComponentData }
		}

		return perEntityData
	},

	/**
	 * Checks if an entity has a component.
	 * @param {number} entityId The entity ID.
	 * @param {Function} ComponentClass The component class.
	 * @returns {boolean}
	 */
	hasComponent(entityId, ComponentClass) {
		const componentTypeId = componentManager.getComponentTypeID(ComponentClass)
		if (componentTypeId === undefined) {
			return false
		}
		return entityManager.hasComponent(entityId, componentTypeId)
	},

	_instantiateChildRecursive(
		prefabData,
		{ rootPrefabName = null, overrides = {}, parentId = null, ownerId = null } = {}
	) {
		const isRoot = rootPrefabName !== null
		const componentData = { ...prefabData.components }

		if (isRoot) {
			// Deep merge overrides
			for (const compName in overrides) {
				componentData[compName] = { ...(componentData[compName] || {}), ...overrides[compName] }
			}
			componentData.PrefabId = { id: rootPrefabName }
		}

		if (parentId) componentData.Parent = { entityId: parentId };
		if (ownerId) componentData.Owner = { entityId: ownerId };

		const entityId = this.createEntity(componentData)
		if (entityId === undefined) return undefined

		const childrenOwnerId = ownerId || entityId

		if (prefabData.children && prefabData.children.length > 0) {
			for (const childData of prefabData.children) {
				this._instantiateChildRecursive(childData, { parentId: entityId, ownerId: childrenOwnerId })
			}
		}
		return entityId
	},
}

window.ECS = ECS
