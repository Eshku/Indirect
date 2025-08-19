const { loadAllManagers } = await import(`${PATH_MANAGERS}/TheManager/ManagerLoader.js`)

// Define the explicit initialization order of managers.
// This order is crucial due to dependencies between managers.
const MANAGER_INIT_ORDER = [
	// --- Core Engine & ECS Foundation ---
	// These managers provide the foundational services for the engine and the
	// Entity-Component-System architecture. They have few dependencies on each other
	// and must be initialized in this specific order.
	'ComponentManager',
	'LayerManager',
	'GameManager',
	'PhysicsManager',
	'PrefabManager',
	'AssetManager',
	'EntityManager',
	'ArchetypeManager',

	// --- Logic & System Orchestration ---
	// These managers query the game state and execute game logic.
	'QueryManager', // Depends on ComponentManager, ArchetypeManager.
	'SystemManager',

	// --- User-Facing Subsystems ---
	// Managers that handle direct interaction with the user.
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
	 * 1. It first imports and instantiates all managers.
	 * 2. It then calls the `init` method on each manager, passing itself as an argument.
	 *    This allows each manager to access any other manager it depends on without
	 *    using global imports, which is key for testability.
	 */
	async init() {
		// 1. Load all manager modules and get their instances.
		const loadedManagers = await loadAllManagers()

		// 2. Register all the loaded managers.
		this.registerManagers(loadedManagers)

		// 3. Initialize the registered managers in the correct order.
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
			const instance = this.managers.get(className) // Get instantiated manager

			if (instance) {
				if (typeof instance.init === 'function') {
					try {
						// The `init` method on managers can access other managers via `theManager`
						// because they are all registered on `this` instance.
						await instance.init()
					} catch (error) {
						console.error(`TheManager: Error initializing manager ${className}:`, error)
						throw error // Re-throw to halt initialization if a core manager fails
					}
				}
			} else {
				// This is a critical failure. A manager in the init order was not loaded/registered.
				const errorMsg = `TheManager: Critical manager "${className}" from MANAGER_INIT_ORDER was not found for initialization. Halting.`
				console.error(errorMsg)
				throw new Error(errorMsg)
			}
		}
	}
}

// Export a singleton instance of TheManager
export const theManager = new TheManager()
