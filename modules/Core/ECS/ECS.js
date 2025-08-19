const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { Entity } = await import(`${PATH_MANAGERS}/EntityManager/Entity.js`)

const { entityManager, componentManager, commandBuffer } = theManager.getManagers()

export const ECS = {
	// --- Debugging & Inspection ---
	// These methods are intended for use in the developer console for inspecting the world state.

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
		return entityManager.createEntity(componentsInput)
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
	instantiate(prefabId, overrides = {}) {
		return entityManager.instantiate(prefabId, { overrides })
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
		return entityManager.addComponent(entityId, ComponentClass, data)
	},

	/**
	 * Removes a component from an entity immediately.
	 * @param {number} entityId The entity ID.
	 * @param {Function} ComponentClass The component class.
	 * @returns {boolean} True on success.
	 */
	removeComponent(entityId, ComponentClass) {
		return entityManager.removeComponent(entityId, ComponentClass)
	},

	/**
	 * Gets a component's data from an entity.
	 * @param {number} entityId The entity ID.
	 * @param {Function} ComponentClass The component class.
	 * @returns {object|undefined} The component data instance.
	 */
	getComponent(entityId, ComponentClass) {
		return entityManager.getComponent(entityId, ComponentClass)
	},

	/**
	 * Checks if an entity has a component.
	 * @param {number} entityId The entity ID.
	 * @param {Function} ComponentClass The component class.
	 * @returns {boolean}
	 */
	hasComponent(entityId, ComponentClass) {
		return entityManager.hasComponent(entityId, ComponentClass)
	},
}

window.ECS = ECS
