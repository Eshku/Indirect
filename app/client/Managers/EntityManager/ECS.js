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
		const gameLoop = this.systemManager?.gameLoop
		if (!gameLoop) return 1 // Not initialized, default to tick 1.

		// Before the loop starts, changes should be part of the first tick.
		if (gameLoop.frameCounter === 0) return 1

		// During the loop, changes are part of the current world tick.
		return gameLoop.currentTick
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
		const payload = this.payloadCompiler.compile(componentsInput)
		payload.count = 1 // Ensure it's a single entity payload
		const tick = this.getTick()
		// The entity manager method now handles dirty tracking internally.
		return this.entityManager.createEntityFromSoaPayload(payload, tick)
	}

	/**
	 */
	destroyEntity(entityId) {
		return this.entityManager.destroyEntity(entityId)
	}

	destroyAll() {
		// This is a full world reset. It must clear the state of all managers
		// that hold world data to ensure true test isolation.
		this.entityManager.destroyAll()
		// Clear all existing mask data. It's the responsibility of the test setup
		// (or a full application reload) to re-initialize state if needed.
		this.entityMaskManager.clear()
	}

	/**
	 * Instantiates an entity from a prefab immediately.
	 */
	instantiate(prefabName, overrides = {}, { parentId = null, ownerId = null } = {}) {
		const finalOverrides = { ...overrides } // Create a copy to avoid mutating the caller's object
		if (parentId) finalOverrides.Parent = { entityId: parentId }
		if (ownerId) finalOverrides.Owner = { entityId: ownerId }

		// Use the compiler to handle prefab logic and all overrides consistently.
		const payload = this.payloadCompiler.compile(prefabName, { overrides: finalOverrides })
		const tick = this.getTick()
		// The entity manager method now handles dirty tracking internally.
		return this.entityManager.createEntityFromSoaPayload(payload, tick)
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
		// The immediate-mode API is responsible for preparing the data object before
		// calling the compiler. This keeps the compiler "dumber" and focused on its
		// core task of creating SoA payloads from a standard object format.
		const componentObject = { [componentName]: data }
		const payload = this.payloadCompiler.compile(componentObject)
		const tick = this.getTick()
		// The entity manager method now handles dirty tracking internally.
		return this.entityManager.addComponent(entityId, payload, tick)
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
	 * Sets the data for a single component on an entity immediately.
	 * This is a non-structural change and is faster than add/remove.
	 * @param {bigint} entityId The entity to modify.
	 * @param {string} componentName The name of the component.
	 * @param {object} data The new data for the component.
	 * @returns {boolean} True on success.
	 */
	setComponent(entityId, componentName, data = {}) {
		// This is now a convenience wrapper around setComponents.
		return this.setComponents(entityId, { [componentName]: data })
	}

	/**
	 * Sets the data for multiple components on an entity immediately.
	 * @param {bigint} entityId The entity to modify.
	 * @param {object} componentsInput An object of component data, e.g., `{ position: {x:1}, velocity: {x:1} }`.
	 */
	setComponents(entityId, componentsInput) {
		const payload = this.payloadCompiler.compile(componentsInput)
		const tick = this.getTick()
		return this.entityManager.setComponentsDataImmediate(entityId, payload, tick, false)
	}

	/**
	 * Sets the data for multiple components on an entity immediately, bypassing
	 * dirty tracking and automatic state mask updates.
	 * @param {bigint} entityId The entity to modify.
	 * @param {object} componentsInput An object of component data.
	 */
	setComponentsSilent(entityId, componentsInput) {
		const payload = this.payloadCompiler.compile(componentsInput)
		const tick = this.getTick()
		return this.entityManager.setComponentsDataImmediate(entityId, payload, tick, true)
	}

	/**
	 * Gets a component's data from an entity.
	 */
	getComponent(entityId, componentName) {
		const componentTypeId = Schema.componentNameToTypeID.get(componentName.toLowerCase())

		const location = this.entityManager.getEntityLocation(entityId)
		
		if (!location) {
			console.error(`[ECS.getComponent] Could not find location for entity ${entityId}. Is it active?`)
			return undefined
		}

		const { chunkId, indexInChunk } = location

		const rawData = {}
		const info = Schema.componentInfo[componentTypeId]
		const componentArrays = entityStore.chunkComponentData[chunkId][componentTypeId]
		if (!componentArrays) {
			// This is a critical error. It means we are trying to get a component from an entity
			// that does not have it, according to its archetype. This can happen if getComponent
			// is called on an entity that doesn't have it.
			console.error(
				`[ECS.getComponent] Data integrity error: Entity ${entityId} in chunk ${chunkId} (archetype ${location.archetypeId}) does not have component data for ${componentName} (ID: ${componentTypeId}).`,
			)
			return undefined
		}

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
		return archetypeId !== undefined ? this.entityManager.archetypeHasComponent(archetypeId, componentTypeId) : false
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

	getEntityLocation(entityId) {
		return this.entityManager.getEntityLocation(entityId)
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

	/**
	 * Retrieves the read-only registry of all event channels.
	 * This is the primary, type-safe way to access event channels from outside of a system.
	 * @returns {Object.<string, import('../EventManager/EventManager.js').InstantEventChannel>}
	 */
	getEvents() {
		// We access the eventManager via the engine instance, as it is guaranteed to be
		// initialized by the time this method is called.
		return this.engine.eventManager.getChannels()
	}

	/**
	 * A test and debug helper to immediately execute all commands in the global command buffer.
	 * This is equivalent to the `flush()` helper available inside systems.
	 * @param {number} [timestampTick] - The tick to timestamp the changes with. If not provided, it defaults to the current tick + 1.
	 */
	executeCommandBuffer(timestampTick) {
		if (!this.systemManager) {
			throw new Error('ECS.executeCommandBuffer called before ECS was initialized with a SystemManager.')
		}
		// If no tick is provided, default to the next tick for reactivity.
		const tick = timestampTick ?? this.systemManager.currentTick + 1

		this.systemManager.commandBufferExecutor.flush(this.systemManager.entityCommandBuffer, tick)
	}
}

export const ecs = new ECS()
window.ECS = ecs
