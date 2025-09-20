const { loadAllManagers } = await import(`${PATH_MANAGERS}/TheManager/ManagerLoader.js`)

// Define the explicit initialization order of managers.
// This order is crucial due to dependencies between managers.
const MANAGER_INIT_ORDER = [
	// Non-ECS Services & Low-Level ECS ---
	// These have minimal dependencies and provide foundational services.
	'LayerManager',
	'GameManager',
	'PhysicsManager',
	'PrefabManager',
	'AssetManager',
	'ComponentManager', // Must be before Archetype/Entity

	// Core ECS Data Structures ---
	// These managers are tightly coupled and depend on ComponentManager.
	'ArchetypeManager',
	'EntityManager',
	'QueryManager', // Depends on ArchetypeManager

	// High-Level Engine Systems ---
	// These depend on a fully initialized ECS.
	'ECS',
	'SystemManager',
	'UiManager',
	'InputManager',

	// --- Utility & Development ---
	// Auxiliary managers for features like serialization and testing.
	'TestManager',
]

/**
 * A central class responsible for creating, initializing, and holding all other managers.
 * This pattern is a form of "Service Locator" or "Dependency Injection Container" and
 * helps to decouple managers from each other, making the system more modular and testable.
 */
export class TheManager {
	constructor() {
		/** @type {Map<string, object>} */
		this.managers = new Map()
	}

	/**
	 * Initializes all managers in a specific order.
	 */
	async init() {
		//Load all manager modules and get their instances.
		const loadedManagers = await loadAllManagers()

		// Register all the loaded managers.
		this.registerManagers(loadedManagers)

		// Initialize the registered managers in the correct order.
		await this.initializeManagers()
	}

	/**
	 * Retrieves a manager instance by its class name.
	 * @param {string} className - The class name of the manager to retrieve (e.g., 'ComponentManager').
	 * @returns {object | undefined} The manager instance, or undefined if not found.
	 */
	getManager(className) {
		const instance = this.managers.get(className)
		return instance
	}

	/**
	 * Retrieves all manager instances as an object, keyed by their class names.
	 * Useful for destructuring multiple managers in one line.
	 * @returns {Object.<string, object>} An object containing all manager instances,
	 *                                    with keys in camelCase (e.g., `assetManager`).
	 */
	getManagers() {
		const result = {}
		for (const [className, instance] of this.managers.entries()) {
			result[className.charAt(0).toLowerCase() + className.slice(1)] = instance
		}
		return result
	}

	/**
	 * Registers all loaded manager instances.
	 * This populates the `managers` map and attaches instances to `this` for DI.
	 * @param {Map<string, object>} loadedManagers - A map of loaded manager instances.
	 * @public
	 */
	registerManagers(loadedManagers) {
		for (const [className, instance] of loadedManagers.entries()) {
			const instanceName = className.charAt(0).toLowerCase() + className.slice(1)
			// For dependency injection via theManager.someManager
			this[instanceName] = instance
			this.managers.set(className, instance)
		}
	}

	/**
	 * Calls the `init` method on all instantiated managers in `MANAGER_INIT_ORDER`.
	 * @public
	 */
	async initializeManagers() {
		for (const className of MANAGER_INIT_ORDER) {
			const instance = this.managers.get(className)

			if (instance) {
				await instance?.init(this)
			} else {
				const errorMsg = `TheManager: Critical manager "${className}" from MANAGER_INIT_ORDER was not found for initialization. Halting.`
				console.error(errorMsg)
				throw new Error(errorMsg)
			}
		}
	}
}

export const theManager = new TheManager()
