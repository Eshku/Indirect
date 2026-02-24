import * as Schema from '../ComponentManager/ComponentSchema.js'
const { ComponentManager } = await import('../ComponentManager/ComponentManager.js')
import { entityStore } from './EntityManager.js'
const { reconstruct } = await import('../ComponentManager/ComponentInterpreter.js')
const { EntityManager } = await import('./EntityManager.js')
const { QueryManager } = await import('../../Managers/QueryManager/QueryManager.js')
const { PrefabManager } = await import('../../Managers/PrefabManager/PrefabManager.js')
const { SystemManager } = await import('../SystemManager/SystemManager.js')
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

const { sharedDataManager } = await import(`${PATH_ECS}/SharedDataManager/SharedDataManager.js`)

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

		this.sharedDataManager = sharedDataManager

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
		this.engine = engine

		await this.componentManager.init(this)
		await this.entityManager.init(this) // EntityManager now depends on ComponentManager
		await this.queryManager.init(this)
		await this.prefabManager.init(this)
		await this.sharedDataManager.init(this.componentManager)
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
		// This is more complex now. We can count non-undefined versions.
		return entityStore.entityVersion.filter(v => v !== undefined).length
	}

	/**
	 * Creates an entity immediately.
	 */
	createEntity(componentsInput = {}) {
		if (Object.keys(componentsInput).length === 0) {
			return this.entityManager.createEntity()
		}

		// Binary path as the command buffer,
		// but executes immediately. This ensures all entity creation is consistent. We use the SoA path for single entity creation as it's the most efficient.
		const { payload } = this.payloadCompiler.compileEntity(componentsInput)
		const entityID = this.entityManager.createEntityFromBinarySoAPayload(
			payload.archetypeId,
			payload.data,
			this.systemManager.currentTick,
		)
		return entityID
	}

	/**
	 */
	destroyEntity(entityId) {
		return this.entityManager.destroyEntity(entityId)
	}

	/**
	 * Instantiates an entity from a prefab immediately.
	 */
	instantiate(prefabName, overrides = {}, { parentId = null, ownerId = null } = {}) {
		const prefabData = this.prefabManager.getPrefabData(prefabName)

		if (!prefabData) {
			console.error(
				`ECS: Failed to sync-instantiate entity. Prefab '${prefabName}' is not pre-loaded or registered in the manifest.`,
			)
			return undefined
		}
		return this._instantiateChildRecursive(prefabData, { rootPrefabName: prefabName, overrides, parentId, ownerId })
	}

	/**
	 */
	_instantiateChildRecursive(
		prefabData,
		{ rootPrefabName = null, overrides = {}, parentId = null, ownerId = null } = {},
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
	 */
	isEntityActive(entityId) {
		return this.entityManager.isEntityActive(entityId)
	}

	/**
	 * Adds a component to an entity immediately.
	 */
	addComponent(entityId, componentName, data = {}) {
		const componentTypeId = Schema.componentNameToTypeID.get(componentName.toLowerCase())
		if (componentTypeId === undefined) {
			console.warn(`ECS.addComponent: Component "${componentName}" not registered.`)
			return false
		}
		// Use the payload compiler to create the minimal binary payload for the new component.
		const { payload } = this.payloadCompiler.compileComponent(componentTypeId, data)
		return this.entityManager.addComponent(entityId, componentTypeId, payload.data, this.systemManager.currentTick)
	}

	/**
	 * Removes a component from an entity immediately.
	 */
	removeComponent(entityId, componentName) {
		const componentTypeId = Schema.componentNameToTypeID.get(componentName.toLowerCase())
		if (componentTypeId === undefined) {
			// No need to warn, the component isn't even registered in the system.
			return false
		}
		return this.entityManager.removeComponent(entityId, componentTypeId, this.systemManager.currentTick)
	}

	/**
	 * Gets a component's data from an entity.
	 */
	getComponent(entityId, componentName) {
		const componentTypeId = Schema.componentNameToTypeID.get(componentName.toLowerCase())
		if (componentTypeId === undefined) {
			// Component isn't registered, so no entity can have it.
			return undefined
		}

		const location = this.entityManager.getEntityLocation(entityId)
		if (!location) return undefined

		// The location object now contains the archetypeId. We can check component existence here.
		if (!this.entityManager.hasComponentType(location.archetypeId, componentTypeId)) {
			return undefined
		}
		const { chunkId, indexInChunk } = location

		const rawData = {}
		const info = Schema.componentInfo[componentTypeId]
		const componentArrays = entityStore.chunkComponentData[chunkId]?.[componentTypeId]

		for (const propKey of info.propertyKeys) {
			const propArray = componentArrays[propKey]
			if (propArray) {
				rawData[propKey] = propArray[indexInChunk]
			}
		}
		const perEntityData = reconstruct(componentTypeId, rawData)

		// Find and merge the instance-shared data if the component has any shared properties.
		if (info.sharedProperties.length === 0) {
			return perEntityData // No shared properties, return as-is.
		}

		const prototypeId = perEntityData.prototypeId
		if (prototypeId === undefined) {
			return perEntityData // No prefab, so no shared data.
		}

		const prototype = this.sharedDataManager.prototypeStore[prototypeId]
		const sharedDataIndex = prototype ? prototype[componentTypeId] : undefined
		const rawSharedData = sharedDataIndex
			? this.sharedDataManager.valueStores[componentTypeId][sharedDataIndex]
			: undefined
		const reconstructedSharedData = reconstruct(componentTypeId, rawSharedData)

		return { ...reconstructedSharedData, ...perEntityData }
	}

	/**
	 * Checks if an entity has a component.
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
	 */
	getTypeIDs() {
		return this.componentManager.getTypeIDs()
	}

	/**
	 * A utility to destructure component type IDs directly onto a system's `this` context.
	 * This replaces the common two-line pattern of getting IDs and using Object.assign.
	 * @param {object} context - The `this` context of the class instance.
	 * @param {string[]} componentNames - An array of component names to assign.
	 * @example ecs.assignComponents(this, ['position', 'velocity'])
	 */
	assignComponents(context, componentNames) {
		const typeIDs = this.componentManager.getTypeIDs()

		for (const name of componentNames) {
			// Use hasOwnProperty for safety, though typeIDs is a clean object.
			if (Object.prototype.hasOwnProperty.call(typeIDs, name)) {
				context[name] = typeIDs[name]
			} else {
				console.warn(`[ECS.assignComponents] Component name "${name}" not found.`)
			}
		}
	}
}

export const ecs = new ECS()
window.ECS = ecs
