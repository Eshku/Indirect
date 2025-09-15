const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { Entity } = await import(`${PATH_ECS}/EntityManager/Entity.js`)
import * as Schema from '../ComponentManager/ComponentSchema.js'

const { entityManager, componentManager, prefabManager, propertyGroupManager, archetypeManager, systemManager } =
	theManager.getManagers()

const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

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
	 * @param {bigint} entityID The ID of the entity to wrap.
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
	 * @returns {bigint|undefined} The new entity's ID.
	 * @example ECS.createEntity({ position: { x: 10 }, velocity: { y: 5 } })
	 */
	createEntity(componentsInput = {}) {
		if (Object.keys(componentsInput).length === 0) {
			return entityManager.createEntity()
		}

		// This now uses the same hyper-optimized binary path as the command buffer,
		// but executes immediately. This ensures all entity creation is consistent.
		// We use the SoA path for single entity creation as it's the most efficient.
		const { payload } = payloadCompiler.compileEntity(componentsInput)
		const entityID = entityManager.createEntityFromBinarySoAPayload(
			payload.archetypeId,
			payload.data,
			systemManager.currentTick
		)
		return entityID
	},

	/**
	 * Destroys an entity immediately.
	 * @param {bigint} entityId The ID of the entity to destroy.
	 * @returns {boolean} True if the entity was active and destroyed.
	 */
	destroyEntity(entityId) {
		return entityManager.destroyEntity(entityId)
	},

	/**
	 * Instantiates an entity from a prefab immediately.
	 * @param {string} prefabName The name of the prefab.
	 * @param {object} [overrides={}] Component data to override prefab defaults. // @returns {bigint|undefined} The new root entity's ID.
	 * @returns {number|undefined} The new root entity's ID.
	 */
	instantiate(prefabName, overrides = {}, { parentId = null, ownerId = null } = {}) {
		const prefabData = prefabManager.getPrefabData(prefabName)

		if (!prefabData) {
			console.error(
				`ECS: Failed to sync-instantiate entity. Prefab '${prefabName}' is not pre-loaded or registered in the manifest.`
			)
			return undefined
		}
		return this._instantiateChildRecursive(prefabData, { rootPrefabName: prefabName, overrides, parentId, ownerId })
	},

	/**
	 * Checks if an entity is active.
	 * @param {bigint} entityId The entity ID.
	 * @returns {boolean}
	 */
	isEntityActive(entityId) {
		return entityManager.isEntityActive(entityId)
	},

	/**
	 * Adds a component to an entity immediately.
	 * @param {bigint} entityId The entity ID.
	 * @param {string} componentName The component's string name.
	 * @param {object} [data] The component's initial data.
	 * @returns {boolean} True on success.
	 */
	addComponent(entityId, componentName, data = {}) {
		const componentTypeId = Schema.componentNameToTypeID.get(componentName.toLowerCase())
		if (componentTypeId === undefined) {
			console.warn(`ECS.addComponent: Component "${componentName}" not registered.`)
			return false
		}
		// Use the payload compiler to create the minimal binary payload for the new component.
		const { payload } = payloadCompiler.compileComponent(componentTypeId, data)
		return entityManager.addComponent(entityId, componentTypeId, payload)
	},

	/**
	 * Removes a component from an entity immediately.
	 * @param {bigint} entityId The entity ID.
	 * @param {string} componentName The component's string name.
	 * @returns {boolean} True on success.
	 */
	removeComponent(entityId, componentName) {
		const componentTypeId = Schema.componentNameToTypeID.get(componentName.toLowerCase())
		if (componentTypeId === undefined) {
			// No need to warn, the component isn't even registered in the system.
			return false
		}
		return entityManager.removeComponent(entityId, componentTypeId) // This now works via _moveEntityToNewArchetype
	},

	/**
	 * Gets a component's data from an entity.
	 * @param {bigint} entityId The entity ID.
	 * @param {string} componentName The component's string name.
	 * @returns {object|undefined} The component data instance.
	 */
	getComponent(entityId, componentName) {
		const componentTypeId = Schema.componentNameToTypeID.get(componentName.toLowerCase())
		if (componentTypeId === undefined) {
			// Component isn't registered, so no entity can have it.
			return undefined
		}
		const archetype = entityManager.getArchetypeForEntity(entityId)
		if (archetype === undefined || !archetypeManager.hasComponentType(archetype, componentTypeId)) {
			return undefined
		}

		// Reconstruct the per-entity data stored on the chunk.
		const perEntityData = componentManager.reconstructComponentData(entityId, componentTypeId)

		// Find and merge the instance-shared data if the component has any shared properties.
		const info = Schema.componentInfo[componentTypeId]
		if (info.sharedProperties.length === 0) {
			return perEntityData // No shared properties, return as-is.
		}

		// Get the sharedGroupId from the per-entity data.
		// This property is added by the SchemaCompiler if the component has shared properties.
		const sharedGroupId = perEntityData.sharedGroupId
		if (sharedGroupId === undefined) {
			return perEntityData // No prefab, so no shared data.
		}

		const sharedGroup = propertyGroupManager.getSharedGroup(sharedGroupId)
		const rawSharedData = sharedGroup ? sharedGroup[componentTypeId] : undefined
		const reconstructedSharedData = componentManager.reconstructSharedData(componentTypeId, rawSharedData)

		// Merge per-entity data over the shared data.
		return { ...reconstructedSharedData, ...perEntityData }
	},

	/**
	 * Checks if an entity has a component.
	 * @param {bigint} entityId The entity ID.
	 * @param {string} componentName The component's string name.
	 * @returns {boolean}
	 */
	hasComponent(entityId, componentName) {
		const componentTypeId = Schema.componentNameToTypeID.get(componentName.toLowerCase())
		if (componentTypeId === undefined) return false
		if (!entityManager.isEntityActive(entityId)) return false
		const archetype = entityManager.getArchetypeForEntity(entityId)
		return archetype !== undefined ? archetypeManager.hasComponentType(archetype, componentTypeId) : false
	},

	_instantiateChildRecursive(
		prefabData,
		{ rootPrefabName = null, overrides = {}, parentId = null, ownerId = null } = {}
	) {
		const isRoot = rootPrefabName !== null
		const componentData = { ...prefabData.components }

		if (isRoot && overrides) {
			// Deep merge overrides
			for (const compName in overrides) {
				componentData[compName] = { ...(componentData[compName] || {}), ...overrides[compName] }
			}
		}

		if (parentId) componentData.Parent = { entityId: parentId }
		if (ownerId) componentData.Owner = { entityId: ownerId }

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
