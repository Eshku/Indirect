/**
 * @fileoverview A central registry for all game systems.
 * It handles registration of system classes, and the instantiation, storage, and retrieval of their instances.
 */

/**
 * A central registry for all game systems.
 */
class SystemRegistry {
	constructor() {
		/**
		 * Stores all registered system classes, keyed by their class name.
		 * @type {Map<string, Function>}
		 */
		this.systemClasses = new Map()

		/**
		 * Stores all instantiated systems, keyed by their class name.
		 * @type {Map<string, object>}
		 */
		this.systemInstances = new Map()
	}

	/**
	 * Registers all system classes from the loaded modules.
	 * @param {Map<string, object>} systemModules - A map of loaded system modules from systemLoader.
	 */
	registerSystemClasses(systemModules) {
		for (const [name, module] of systemModules.entries()) {
			const SystemClass = module[name]
			if (SystemClass && typeof SystemClass === 'function') {
				this.systemClasses.set(name, SystemClass)
			} else {
				console.error(`SystemRegistry: Could not find system class export "${name}" in its module.`)
			}
		}
	}

	/**
	 * Instantiates a single system and stores it. If already instantiated, returns the existing instance.
	 * @param {string} systemName - The class name of the system to instantiate.
	 * @returns {object | undefined} The created system instance.
	 */
	instantiateSystem(systemName) {
		if (this.systemInstances.has(systemName)) {
			return this.systemInstances.get(systemName)
		}

		const SystemClass = this.systemClasses.get(systemName)
		if (SystemClass) {
			try {
				const systemInstance = new SystemClass()
				this.systemInstances.set(systemName, systemInstance)
				return systemInstance
			} catch (error) {
				console.error(`SystemRegistry: Failed to instantiate system ${SystemClass.name}:`, error)
			}
		} else {
			console.error(`SystemRegistry: System class "${systemName}" not registered.`)
		}
		return undefined
	}

	/**
	 * Retrieves a system instance by its class name.
	 * @param {string} systemName - The class name of the system.
	 * @returns {object | undefined} The system instance, or undefined if not found.
	 */
	getSystem(systemName) {
		return this.systemInstances.get(systemName)
	}

	/**
	 * Retrieves a system class by its class name.
	 * @param {string} systemName - The class name of the system.
	 * @returns {Function | undefined} The system class, or undefined if not found.
	 */
	getSystemClass(systemName) {
		return this.systemClasses.get(systemName)
	}

	/**
	 * Unregisters a system instance from the registry.
	 * @param {object|string} systemOrName - The system instance or its class name to unregister.
	 * @returns {boolean} True if the system was found and removed, false otherwise.
	 */
	unregisterSystem(systemOrName) {
		const systemName = typeof systemOrName === 'string' ? systemOrName : systemOrName?.constructor.name
		if (!systemName) {
			console.warn('SystemRegistry.unregisterSystem: Invalid argument provided. Must be a system instance or name.')
			return false
		}

		const deletedInstance = this.systemInstances.delete(systemName)
		const deletedClass = this.systemClasses.delete(systemName)

		if (!deletedInstance && !deletedClass) {
			console.warn(`SystemRegistry: System ${systemName} was not registered to begin with.`)
		}
		return deletedInstance || deletedClass
	}

	/**
	 * Clears all registered systems.
	 */
	clear() {
		this.systemClasses.clear()
		this.systemInstances.clear()
	}
}

export const systemRegistry = new SystemRegistry()
