// Define the explicit initialization order of managers.
// This order is crucial due to dependencies between managers.
const MANAGER_INIT_ORDER = [
	'LayerManager',
	'PhysicsManager',
	'GameManager',
	'AssetManager',
	'SharedDataManager',

	// High-Level Engine Systems ---
	// These depend on a fully initialized ECS.
	`WorkerManager`,


	'ecs',
	'ComponentManager',
	'PayloadCompiler',
	'EntityManager',
	'QueryManager',
	'EntityMaskManager',
	'PrefabManager',
	'SystemManager',


	// --- User-Facing systems ---
	'UiManager',
	'InputManager',

	// --- Utility & Development ---
	// Auxiliary managers for features like serialization and testing.
	'TestManager',
]

const { toCamelCase } = await import('@core/utils/stringUtils.js')

export class Engine {
	constructor() {
		/** @type {Map<string, object>} */
		this.managers = new Map()
		this._cachedManagersObject = null
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
		if (this._cachedManagersObject) {
			return this._cachedManagersObject
		}
		const result = {}
		for (const [className, instance] of this.managers.entries()) {
			result[toCamelCase(className)] = instance
		}
		this._cachedManagersObject = Object.freeze(result)
		return this._cachedManagersObject
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
		// Invalidate the cache if managers are ever re-registered.
		this._cachedManagersObject = null
	}

	/**
	 * Calls the `init` method on all instantiated managers in `MANAGER_INIT_ORDER`.
	 * @public
	 */
	async initializeManagers() {
		for (const className of MANAGER_INIT_ORDER) {
			const instance = this.managers.get(className)

			if (instance) {
				//console.log(instance)
				await instance?.init(this)
				//console.log(`Instance ${instance.constructor.name} initialized`)
			} else {
				const errorMsg = `Engine: Critical manager "${className}" from MANAGER_INIT_ORDER was not found for initialization. Halting.`
				console.error(errorMsg)
				throw new Error(errorMsg)
			}
		}
	}

	async loadAllManagers() {
		const loadedManagers = new Map()


		const { ecs } = await import('@managers/EntityManager/ECS.js')
		loadedManagers.set('ecs', ecs)

		const { payloadCompiler } = await import(`@managers/SystemManager/PayloadCompiler.js`)
		loadedManagers.set('PayloadCompiler', payloadCompiler)


		const { componentManager } = await import('@managers/ComponentManager/ComponentManager.js')
		loadedManagers.set('ComponentManager', componentManager)

		const { entityManager } = await import('@managers/EntityManager/EntityManager.js')
		loadedManagers.set('EntityManager', entityManager)


		const { queryManager } = await import('@managers/QueryManager/QueryManager.js')
		loadedManagers.set('QueryManager', queryManager)

		const { prefabManager } = await import('@managers/PrefabManager/PrefabManager.js')
		loadedManagers.set('PrefabManager', prefabManager)
		const { systemManager } = await import('@managers/SystemManager/SystemManager.js')
		loadedManagers.set('SystemManager', systemManager)

		const { layerManager } = await import('@managers/LayerManager/LayerManager.js')
		loadedManagers.set('LayerManager', layerManager)

		const { gameManager } = await import('@managers/GameManager/GameManager.js')
		loadedManagers.set('GameManager', gameManager)

		const { assetManager } = await import('@managers/AssetManager/AssetManager.js')
		loadedManagers.set('AssetManager', assetManager)

		// --- User-Facing systems ---
		const { uiManager } = await import('@managers/UiManager/UiManager.js')
		loadedManagers.set('UiManager', uiManager)

		const { inputManager } = await import('@managers/InputManager/InputManager.js')
		loadedManagers.set('InputManager', inputManager)

		// --- Utility & Development ---
		const { testManager } = await import('@managers/TestManager/TestManager.js')
		loadedManagers.set('TestManager', testManager)

		const { workerManager } = await import('@managers/WorkerManager/WorkerManager.js')
		loadedManagers.set('WorkerManager', workerManager)

		const { physicsManager } = await import('@managers/PhysicsManager/PhysicsManager.js')
		loadedManagers.set('PhysicsManager', physicsManager)

		const { sharedDataManager } = await import('@managers/SharedDataManager/SharedDataManager.js')
		loadedManagers.set('SharedDataManager', sharedDataManager)

		const { entityMaskManager } = await import('@managers/EntityMaskManager/EntityMaskManager.js')
		loadedManagers.set('EntityMaskManager', entityMaskManager)

		return loadedManagers
	}
}

export const engine = new Engine()
