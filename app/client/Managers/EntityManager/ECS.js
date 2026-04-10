import * as Schema from '../ComponentManager/ComponentSchema.js'

const { entityStore } = await import(`@managers/EntityManager/EntityManager.js`)
const { reconstruct } = await import(`@managers/ComponentManager/ComponentInterpreter.js`)
const { getConstantsFor, getConstantsForProperty } = await import(`@managers/ComponentManager/ComponentConstants.js`)

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

		this.payloadCompiler = engine.payloadCompiler

		this.componentManager = engine.componentManager
		this.entityManager = engine.entityManager
		this.systemManager = engine.systemManager
		this.prefabManager = engine.prefabManager
		this.entityMaskManager = engine.entityMaskManager
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
			data: data,
		}
	}

	/**
	 * Gets the current number of active entities.
	 * @returns {number} The number of active entities.
	 */
	getEntityCount() {
		return entityStore.entityVersion.filter(v => v !== undefined).length
	}

	/**
	 * Gets the correct tick for an immediate-mode operation.
	 * Before the game loop starts, this is 0. During the loop, it's the current tick.
	 * @private
	 */
	getTick() {
		//! return real tick goddamnit, +1 should be done manually only if needed.

		// The game loop is not available during the initial manager init phase.
		if (!this.systemManager?.gameLoop) return 0
		// For pre-loop setup (frame 0), use tick 0.
		if (this.systemManager.gameLoop.frameCounter === 0) return 0
		// For in-loop calls, timestamp with the *next* tick to ensure next-frame reactivity, mirroring the command buffer's behavior.
		return this.systemManager.currentTick + 1
	}

	/**
	 * Creates an entity immediately.
	 */
	createEntity(componentsInput = {}) {
		if (Object.keys(componentsInput).length === 0) {
			return this.entityManager.createEntity() // This doesn't need a tick.
		}

		// Binary path as the command buffer,
		// but executes immediately. This ensures all entity creation is consistent. We use the SoA path for single entity creation as it's the most efficient.
		const { payload } = this.payloadCompiler.compile(componentsInput)
		const tick = this.getTick()
		const entityID = this.entityManager.createEntityFromAosPayload(payload.archetypeId, payload.data, tick)
		// Manually trigger the narrow-phase dirty mask for trackable components,
		// mirroring the behavior of the CommandBufferExecutor for deferred creation.
		if (payload.trackableComponentIds.length > 0) {
			this.entityMaskManager.markEntitiesDirtyById(entityID, payload.trackableComponentIds, tick)
		}
		return entityID
	}

	/**
	 */
	destroyEntity(entityId) {
		return this.entityManager.destroyEntity(entityId)
	}

	destroyAllEntities() {
		// This is a full world reset. It must clear the state of all managers
		// that hold world data to ensure true test isolation.
		this.entityManager.destroyAllEntities()
		// Clear all existing mask data and re-run the declarative registration
		// to build a clean state for the next test.
		this.entityMaskManager.clear()
		this.entityMaskManager.registerAllSchemaMasks()
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
		const tick = this.getTick()
		const entityID = this.entityManager.createEntityFromAosPayload(payload.archetypeId, payload.data, tick)
		// Manually trigger the narrow-phase dirty mask for trackable components.
		if (payload.trackableComponentIds.length > 0) {
			this.entityMaskManager.markEntitiesDirtyById(entityID, payload.trackableComponentIds, tick)
		}
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

		const { payload } = this.payloadCompiler.compile(componentTypeId, data)

		//! todo this needs to mask
		return this.entityManager.addComponent(entityId, componentTypeId, payload.data, this.getTick())
	}

	/**
	 * Removes a component from an entity immediately.
	 */
	removeComponent(entityId, componentName) {
		const componentTypeId = Schema.componentNameToTypeID.get(componentName.toLowerCase())

		//! todo mask removal once API is there
		return this.entityManager.removeComponent(entityId, componentTypeId, this.getTick())
	}

	/**
	 * Gets a component's data from an entity.
	 */
	getComponent(entityId, componentName) {
		const componentTypeId = Schema.componentNameToTypeID.get(componentName.toLowerCase())

		const location = this.entityManager.getEntityLocation(entityId)

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
	 * Retrieves the static constant map (for enums or bitmasks) for a specific component.
	 * This is a developer-friendly helper for system initialization.
	 * @param {string|number} componentIdentifier - The component name or typeID.
	 * @returns {object | undefined} The read-only constant map (e.g., `{ STATE: { IDLE: 0, ... } }`), or undefined if not found.
	 */
	getConstantsFor(componentIdentifier) {
		return getConstantsFor(componentIdentifier)
	}

	/**
	 * Retrieves the static constant map (for enums or bitmasks) for a specific property of a component.
	 * This is a developer-friendly helper for system initialization.
	 * @param {string|number} componentIdentifier - The name or typeID of the component.
	 * @param {string} propertyName - The name of the property in the component's schema (e.g., 'flags').
	 * @returns {object | undefined} The read-only constant map (e.g., `{ LEFT: 1, RIGHT: 2, ... }`), or undefined if not found.
	 */
	getConstantsForProperty(componentIdentifier, propertyName) {
		const constants = getConstantsForProperty(componentIdentifier, propertyName)
		if (constants === undefined) {
			console.warn(
				`ECS: Could not find constants for property "${propertyName}" on component "${componentIdentifier}".`,
			)
		}
		return constants
	}

	/**
	 * Retrieves an object mapping all registered component names to their numeric type IDs.
	 */
	getComponentIDs() {
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
