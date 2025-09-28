import * as Schema from '../ComponentManager/ComponentSchema.js'
const { ComponentManager } = await import('../ComponentManager/ComponentManager.js')
const { EntityManager } = await import('./EntityManager.js')
const { QueryManager } = await import('../../Managers/QueryManager/QueryManager.js')
const { PrefabManager } = await import('../../Managers/PrefabManager/PrefabManager.js')
const { SystemManager } = await import('../SystemManager/SystemManager.js')

const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)
const { propertyGroupManager } = await import(`${PATH_INDIRECT}/PropertyGroupManager/PropertyGroupManager.js`)

/**
 * The central, immediate-mode public API for the entire ECS.
 * This class provides a clean, high-level interface for interacting with the ECS
 * from outside of a system's update loop (e.g., for setup, one-off events, or testing).
 *
 * It is the user-facing "World" object for the engine.
 */
export class ECS {
	constructor() {
		this.componentManager = new ComponentManager()
		this.queryManager = new QueryManager()
		this.entityManager = new EntityManager()
		this.prefabManager = new PrefabManager()
		this.systemManager = new SystemManager()

		this.propertyGroupManager = propertyGroupManager

		this.engine = null // To hold the reference to the main engine instance

		// The payload compiler is a stateless service, so it's fine to keep it here.
		this.payloadCompiler = payloadCompiler
	}

	/**
	 * Initializes the core ECS managers in the correct dependency order.
	 * This method is called by engine during the engine's startup sequence.
	 * @param {import('../../Engine.js').Engine} engine
	 */
	async init(engine) {
		// Initialize our own scoped managers in the correct dependency order.
		await this.componentManager.init(this)
		await this.entityManager.init(this) // EntityManager now depends on ComponentManager
		await this.queryManager.init(this)
		await this.prefabManager.init(this)
		await this.systemManager.init(this)

		// Finally, initialize the payload compiler which depends on our managers.
		this.payloadCompiler.init(this)
		this.engine = engine
	}

	// ### Deferred vs. Immediate Mode
	//
	// - **Immediate Mode (this API):** Use these methods for one-off actions. They execute
	//   immediately and are more costly.
	// - **Deferred Mode (`commands`):** Inside a system's `update` loop, you should **always**
	//   use the `commands` object (the CommandBuffer) to queue structural changes. This is vastly more performant.

	/**
	 * Returns a debug-friendly object for inspecting an entity's state.
	 * This is intended for debugging and console interaction, not for performance-critical code.
	 * @param {bigint} entityID The ID of the entity to view.
	 * @returns {object | null} An inspection object, or null if the entity is not active.
	 */
	viewEntity(entityID) {
		if (!this.isEntityActive(entityID)) {
			console.warn(`ECS.viewEntity: Cannot view inactive entity ID: ${entityID}`)
			return null
		}

		const archetypeId = this.entityManager.getArchetypeForEntity(entityID)
		const components =
			archetypeId !== undefined ? [...this.componentManager.getComponentNamesForArchetype(archetypeId)].sort() : []

		const data = {}
		for (const componentName of components) {
			data[componentName] = this.getComponent(entityID, componentName)
		}

		return {
			id: entityID,
			archetypeId: archetypeId,
			components: components,
			data: data,
		}
	}

	/**
	 * Gets the current number of active entities.
	 * @returns {number} The number of active entities.
	 */
	getEntityCount() {
		return this.entityManager.activeEntities.size
	}

	/**
	 * Creates an entity immediately.
	 * @param {object} [componentsInput={}] - e.g., `{ Position: { x: 10 }, Velocity: { y: 5 } }`
	 * @returns {bigint|undefined} The new entity's ID.
	 * @example ECS.createEntity({ position: { x: 10 }, velocity: { y: 5 } })
	 */
	createEntity(componentsInput = {}) {
		if (Object.keys(componentsInput).length === 0) {
			return this.entityManager.createEntity()
		}

		// Binary path as the command buffer,
		// but executes immediately. This ensures all entity creation is consistent.
		// We use the SoA path for single entity creation as it's the most efficient.
		const { payload } = this.payloadCompiler.compileEntity(componentsInput)
		const entityID = this.entityManager.createEntityFromBinarySoAPayload(
			payload.archetypeId,
			payload.data,
			this.systemManager.currentTick
		)
		return entityID
	}

	/**
	 * Destroys an entity immediately.
	 * @param {bigint} entityId The ID of the entity to destroy.
	 * @returns {boolean} True if the entity was active and destroyed.
	 */
	destroyEntity(entityId) {
		return this.entityManager.destroyEntity(entityId)
	}

	/**
	 * Instantiates an entity from a prefab immediately.
	 *
	 * ---
	 * ### [DEPRECATION CANDIDATE & PERFORMANCE NOTE]
	 *
	 * This method currently uses a recursive approach (`_instantiateChildRecursive`) to support the `children`
	 * property in prefabs. This declarative hierarchy model is slated for
	 * deprecation in favor of a more flexible system-driven approach.
	 *
	 * A key reason for this deprecation is the **performance cost**. The recursive implementation adds overhead
	 * to **every** `instantiate` call, even for prefabs that have no children. The check for `prefabData.children`
	 * happens on this critical path, imposing a small but unnecessary "tax" on the majority of instantiations.
	 *
	 * By moving this logic into a dedicated system, the generic `instantiate`
	 * method can be simplified to a single, non-recursive entity creation, and the cost of creating children
	 * is only paid when an entity explicitly requires it.
	 * ---
	 * @param {string} prefabName The name of the prefab.
	 * @param {object} [overrides={}] Component data to override prefab defaults.
	 * @returns {bigint|undefined} The new root entity's ID.
	 */
	instantiate(prefabName, overrides = {}, { parentId = null, ownerId = null } = {}) {
		const prefabData = this.prefabManager.getPrefabData(prefabName)

		if (!prefabData) {
			console.error(
				`ECS: Failed to sync-instantiate entity. Prefab '${prefabName}' is not pre-loaded or registered in the manifest.`
			)
			return undefined
		}
		return this._instantiateChildRecursive(prefabData, { rootPrefabName: prefabName, overrides, parentId, ownerId })
	}

	/**
	 * @deprecated This is the recursive implementation for the declarative `children` property in prefabs.
	 * It will be removed when the `children` property is fully deprecated in favor of system-driven hierarchies.
	 * @private
	 */
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
	}

	/**
	 * Checks if an entity is active.
	 * @param {bigint} entityId The entity ID.
	 * @returns {boolean}
	 */
	isEntityActive(entityId) {
		return this.entityManager.isEntityActive(entityId)
	}

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
		const { payload } = this.payloadCompiler.compileComponent(componentTypeId, data)
		return this.entityManager.addComponent(entityId, componentTypeId, payload.data)
	}

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
		return this.entityManager.removeComponent(entityId, componentTypeId)
	}

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
		const archetype = this.entityManager.getArchetypeForEntity(entityId)
		if (archetype === undefined || !this.entityManager.hasComponentType(archetype, componentTypeId)) {
			return undefined
		}

		// Reconstruct the per-entity data stored on the chunk.
		const perEntityData = this.componentManager.reconstructComponentData(entityId, componentTypeId)

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

		const sharedGroup = this.propertyGroupManager.getSharedGroup(sharedGroupId)
		const rawSharedData = sharedGroup ? sharedGroup[componentTypeId] : undefined
		const reconstructedSharedData = this.componentManager.reconstructSharedData(componentTypeId, rawSharedData)

		// Merge per-entity data over the shared data.
		return { ...reconstructedSharedData, ...perEntityData }
	}

	/**
	 * Checks if an entity has a component.
	 * @param {bigint} entityId The entity ID.
	 * @param {string} componentName The component's string name.
	 * @returns {boolean}
	 */
	hasComponent(entityId, componentName) {
		const componentTypeId = Schema.componentNameToTypeID.get(componentName.toLowerCase())
		if (componentTypeId === undefined) return false
		if (!this.entityManager.isEntityActive(entityId)) return false
		const archetypeId = this.entityManager.getArchetypeForEntity(entityId)
		return archetypeId !== undefined ? this.entityManager.hasComponentType(archetypeId, componentTypeId) : false
	}

	/**
	 * Retrieves an object mapping all registered component names to their numeric type IDs.
	 * This is a convenience method that delegates to the ComponentManager. It's ideal for
	 * destructuring in a system's constructor for clean, cached access.
	 * e.g., `const { Position, Velocity } = ecs.getTypeIDs();`
	 * @returns {Object.<string, number>} An object mapping component names to their type IDs.
	 */
	getTypeIDs() {
		return this.componentManager.getTypeIDs()
	}
}

// Create a single instance for the global debug API.
//! Move it out to the engine \ rename the Manager
export const ecs = new ECS()
window.ECS = ecs
