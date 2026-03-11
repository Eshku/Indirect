import * as Schema from '../ComponentManager/ComponentSchema.js'

const { entityStore } = await import(`@managers/EntityManager/EntityManager.js`)
const { reconstruct } = await import(`@managers/ComponentManager/ComponentInterpreter.js`)

const { payloadCompiler } = await import(`@managers/SystemManager/PayloadCompiler.js`)

const { sharedDataManager } = await import(`@managers/SharedDataManager/SharedDataManager.js`)

/**
 * The central, immediate-mode public API for the entire ECS.
 * This class provides a clean, high-level interface for interacting with the ECS
 * from outside of a system's update loop (e.g., for setup, one-off events, or testing).
 *
 * It is the user-facing "World" object for the engine.
 */
export class ECS {
	/**
	 * Initializes the core ECS managers in the correct dependency order.
	 * This method is called by engine during the engine's startup sequence.
	 * @param {import('../../Engine.js').Engine} engine
	 */
	async init(engine) {
		// Initialize our own scoped managers in the correct dependency order.
		this.engine = engine

		this.sharedDataManager = sharedDataManager

		this.payloadCompiler = payloadCompiler

		const { componentManager, entityManager, systemManager, prefabManager } = this.engine.getManagers()
		Object.assign(this, { componentManager, entityManager, systemManager, prefabManager })
		// Finally, initialize the payload compiler which depends on our managers.
		this.payloadCompiler.init(this)
		this.engine = engine
	}

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
		const { payload } = this.payloadCompiler.compile(componentsInput)
		const entityID = this.entityManager.createEntityFromAosPayload(
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
		const finalOverrides = { ...overrides }
		if (parentId) finalOverrides.Parent = { entityId: parentId }
		if (ownerId) finalOverrides.Owner = { entityId: ownerId }

		// Use the compiler to handle prefab logic and all overrides consistently.
		const { payload } = this.payloadCompiler.compile(prefabName, finalOverrides)
		const entityID = this.entityManager.createEntityFromAosPayload(
			payload.archetypeId,
			payload.data,
			this.systemManager.currentTick,
		)
		return entityID
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
		const { payload } = this.payloadCompiler.compile(componentTypeId, data)
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
	 * Retrieves an object mapping all registered system names to their numeric IDs.
	 */
	getSystemIDs() {
		return this.systemManager.getSystemIds()
	}

	/**
	 * Retrieves an object mapping all registered kernel names to their numeric IDs.
	 */
	getKernelIDs() {
		return this.systemManager.getKernelIds()
	}
}

export const ecs = new ECS()
window.ECS = ecs
