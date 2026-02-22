// Define the explicit initialization order of managers.
// This order is crucial due to dependencies between managers.
const MANAGER_INIT_ORDER = [
	// Non-ECS Services & Low-Level ECS ---
	// These have minimal dependencies and provide foundational services.
	'LayerManager',
	'GameManager',
	'PhysicsManager',
	'AssetManager',

	// High-Level Engine Systems ---
	// These depend on a fully initialized ECS.
	`WorkerManager`,
	'ECS',
	//'PropertyGroupManager', // Depends on ComponentManager, does not need to be initialized there
	'UiManager',
	'InputManager',

	// --- Utility & Development ---
	// Auxiliary managers for features like serialization and testing.
	'TestManager',
]

const { toCamelCase } = await import(`${PATH_CORE}/utils/stringUtils.js`)

export class Engine {
	constructor() {
		/** @type {Map<string, object>} */
		this.managers = new Map()
	}

	/**
	 * Initializes all managers in a specific order.
	 */
	async init() {
		//Load all manager modules and get their instances.
		const loadedManagers = await this.loadAllManagers()

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
			result[toCamelCase(className)] = instance
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
			const instanceName = toCamelCase(className)
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
				const errorMsg = `Engine: Critical manager "${className}" from MANAGER_INIT_ORDER was not found for initialization. Halting.`
				console.error(errorMsg)
				throw new Error(errorMsg)
			}
		}
	}

	async loadAllManagers() {
		const loadedManagers = new Map()
		//! prep for restructure, no auto-load for now

		const { ecs } = await import(`${PATH_ECS}/EntityManager/ECS.js`)
		loadedManagers.set('ECS', ecs)

		const { layerManager } = await import(`${PATH_MANAGERS}/LayerManager/LayerManager.js`)
		loadedManagers.set('LayerManager', layerManager)

		const { gameManager } = await import(`${PATH_MANAGERS}/GameManager/GameManager.js`)
		loadedManagers.set('GameManager', gameManager)

		const { physicsManager } = await import(`${PATH_MANAGERS}/PhysicsManager/PhysicsManager.js`)
		loadedManagers.set('PhysicsManager', physicsManager)

		const { assetManager } = await import(`${PATH_MANAGERS}/AssetManager/AssetManager.js`)
		loadedManagers.set('AssetManager', assetManager)

		// --- User-Facing systems ---
		const { uiManager } = await import(`${PATH_MANAGERS}/UiManager/UiManager.js`)
		loadedManagers.set('UiManager', uiManager)

		const { inputManager } = await import(`${PATH_MANAGERS}/InputManager/InputManager.js`)
		loadedManagers.set('InputManager', inputManager)

		// --- Utility & Development ---
		const { testManager } = await import(`${PATH_MANAGERS}/TestManager/TestManager.js`)
		loadedManagers.set('TestManager', testManager)

		const { workerManager } = await import(`${PATH_MANAGERS}/WorkerManager/WorkerManager.js`)
		loadedManagers.set('WorkerManager', workerManager)

		return loadedManagers
	}
}

export const engine = new Engine()
