const { gameManager } = await import(`${PATH_MANAGERS}/GameManager/GameManager.js`)
const { loadAllSystems } = await import(`${PATH_MANAGERS}/SystemManager/systemLoader.js`)
const { systemRegistry } = await import(`${PATH_MANAGERS}/SystemManager/SystemRegistry.js`)
const { GameLoop } = await import(`${PATH_MANAGERS}/SystemManager/GameLoop.js`)
const { systemSchedule } = await import(`${PATH_MANAGERS}/SystemManager/systemConfig.js`)
const { Sequence } = await import(`${PATH_CORE}/DataStructures/Sequence.js`)
const { Query } = await import(`${PATH_MANAGERS}/QueryManager/Query.js`)
const { CommandBuffer } = await import(`${PATH_MANAGERS}/SystemManager/CommandBuffer.js`);
const { CommandBufferExecutor } = await import(`${PATH_MANAGERS}/SystemManager/CommandBufferExecutor.js`);

/**
 * Manages the lifecycle and execution of all game systems.
 * It orchestrates the main game loop, which is composed of multiple update groups running at different frequencies.
 * This includes a deterministic fixed-timestep loop for physics and core gameplay, and variable-rate loops for
 * rendering, UI, and other tasks. It also handles the instantiation of systems.
 *
 * @devnote System classes are registered during `SystemManager.init()`. Instances are created and initialized
 * right before the game loop starts via `SystemManager.initAll()`. Therefore, a system's constructor should not
 * depend on other systems having been instantiated or initialized.
 */
export class SystemManager {
	constructor() {
		this.gameLoop = new GameLoop(this)

		this.app = null
		this.ticker = null
		this.renderer = null

		/** @type {import('../ComponentManager/ComponentManager.js').ComponentManager | null} */
		this.componentManager = null

		/** @type {import('../PrefabManager/PrefabManager.js').PrefabManager | null} */
		this.prefabManager = null

		/** @type {CommandBuffer | null} */
		this.commandBuffer = null

		/** @type {CommandBufferExecutor | null} */
		this.commandBufferExecutor = null

		/** @type {Object.<string, number>} */
		this.systemTimings = {}

		/** @type {Sequence<string>} */
		this._executionOrder = new Sequence()
		/** @type {Map<string, number>} */
		this._executionOrderMap = new Map() // A cache mapping system names to their index

		// This will store the configuration for each system's update rate.
		// Map<SystemClass, { frequency: number | 'fixed' | 'update', groupName: string }>
		this._systemConfig = new Map()

		// Holds the system instances, categorized by their update group.
		this.updateGroups = {
			// Runs first for low-latency user input.
			input: { name: 'input', systems: [], hasChangedSystem: false, lastTick: -1 },
			// Runs on a fixed, deterministic timer for core gameplay logic and physics.
			logic: { name: 'logic', systems: [], hasChangedSystem: false, lastTick: -1 },
			// Runs once per visual frame for rendering, interpolation, and UI.
			visuals: { name: 'visuals', systems: [], hasChangedSystem: false, lastTick: -1 },
		}
	}

	get currentTick() {
		return this.gameLoop.currentTick
	}

	get lastTick() {
		return this.gameLoop.lastTick
	}

	/**
	 * Starts the main game loop.
	 * This loop manages a fixed timestep for gameplay logic and variable updates for other systems.
	 */
	startLoop() {
		this.gameLoop.start()
	}

	/**
	 * Initializes the SystemManager.
	 * 1. Dynamically loads all system modules.
	 * 2. Registers system classes.
	 * 3. Configures system execution order and frequencies.
	 */
	async init() {
		const systemModules = await loadAllSystems()
		this.archetypeManager = (await import(`${PATH_MANAGERS}/ArchetypeManager/ArchetypeManager.js`)).archetypeManager
		this.componentManager = (await import(`${PATH_MANAGERS}/ComponentManager/ComponentManager.js`)).componentManager
		this.queryManager = (await import(`${PATH_MANAGERS}/QueryManager/QueryManager.js`)).queryManager
		this.prefabManager = (await import(`${PATH_MANAGERS}/PrefabManager/PrefabManager.js`)).prefabManager

		this.app = gameManager.getApp()
		this.renderer = this.app.renderer
		this.ticker = this.app.ticker

		this.commandBuffer = new CommandBuffer(this.componentManager, this.prefabManager);
		this.commandBufferExecutor = new CommandBufferExecutor(
			(await import(`${PATH_MANAGERS}/EntityManager/EntityManager.js`)).entityManager,
			this.componentManager,
			this.archetypeManager,
			this,
			this.prefabManager
		);

		systemRegistry.registerSystemClasses(systemModules)

		// --- Configuration Step ---
		// Get the single, flattened execution order from the new group-based config.
		this._defineSystemOrders()
		this._configureSystemFrequencies()
		this._rebuildExecutionOrderMap() // --- Configuration Validation Step ---
		this._validateSystemConfiguration()
		// Initialize the game loop, which will handle its own prerender hook.
		this.gameLoop.init()
	}

	/**
	 * Calls the init method on all systems defined in the execution order.
	 * This is intended to be called once after all initial entities and setup are complete,
	 * but before the main game loop begins.
	 */
	async initAll() {
		// Instantiate and initialize systems based on the execution order.
		for (const systemName of this._executionOrderMap.keys()) {
			const systemInstance = systemRegistry.instantiateSystem(systemName)
			if (systemInstance) {
				systemInstance.commands = this.commandBuffer
				await systemInstance.init?.()
			} else {
				// This might happen if a system is in the order but fails to load/register.
				console.warn(`SystemManager: System "${systemName}" in executionOrder not found during initAll().`)
			}
		}

		// Now that all systems are instantiated and initialized, queue them for execution.
		this.queAll(this._executionOrderMap.keys())
	}

	queAll(executionOrder) {
		for (const systemName of executionOrder) {
			if (systemRegistry.getSystem(systemName)) {
				this.queSystem(systemName)
			}
		}
	}

	/**
	 * Defines the final, flattened execution order for all game systems from the
	 * `systemSchedule` configuration. This is the single source of truth for both
	 * initialization and per-frame execution order tie-breaking. This populates
	 * the internal `_executionOrder` sequence.
	 * @private
	 */
	_defineSystemOrders() {
		this._executionOrder.clear()
		const added = new Set()

		for (const groupName of Object.keys(systemSchedule)) {
			const systemList = systemSchedule[groupName]

			if (Array.isArray(systemList)) {
				for (const systemConfig of systemList) {
					const systemName = systemConfig.name
					if (!added.has(systemName)) {
						this._executionOrder.insert(systemName)
						added.add(systemName)
					}
				}
			} else {
				console.warn(`System group "${groupName}" is not a valid array in systemConfig.`)
			}
		}
	}

	/**
	 * Configures the update frequencies for all game systems based on the schedule.
	 * @private
	 */
	_configureSystemFrequencies() {
		for (const groupName in systemSchedule) {
			const systemList = systemSchedule[groupName]
			if (Array.isArray(systemList)) {
				for (const systemConfig of systemList) {
					if (systemConfig.name && systemConfig.frequency) {
						this.setUpdateFrequency(systemConfig.name, systemConfig.frequency)
					} else {
						console.warn(`System config for group ${groupName} is malformed:`, systemConfig)
					}
				}
			}
		}
	}

	/**
	 * Ques a system for execution in its configured or specified update group.
	 * If the system is already qued, this method does nothing.
	 * After queing, the group is re-sorted based on the main execution order.
	 * @param {string|object} systemToQue - The name or instance of the system to que.
	 * @param {string} [groupName] - Optional. The specific update group name (e.g., 'onFixedUpdate').
	 *                               If not provided, the group is inferred from the system's frequency configuration.
	 * @returns {boolean} True if the system was successfully qued, false otherwise.
	 */
	queSystem(systemToQue, groupName) {
		const systemInstance = this._getSystemInstance(systemToQue, true)
		if (!systemInstance) return false

		const config = this._systemConfig.get(systemInstance.constructor)

		// Systems with 'none' frequency are instantiated and initialized, but intentionally not queued for updates.
		if (config?.frequency === 'none') {
			return true // Successfully "queued" by doing nothing.
		}

		const group = groupName ? this.updateGroups[groupName] : this._getSystemGroupFor(systemInstance)
		if (!group) {
			console.warn(
				`SystemManager: Cannot que system "${systemInstance.constructor.name}". No valid group found or specified.`
			)
			return false
		}

		if (group.systems.includes(systemInstance)) {
			// It's already in the group, no need to add it again.
			return true
		}

		this._primeSystem(systemInstance)
		group.systems.push(systemInstance)

		if (systemInstance.reactive) {
			group.hasChangedSystem = true
		}

		this._sortGroup(group)

		return true
	}

	/**
	 * Deques a system from execution.
	 * @param {string|object} systemToDeque - The name or instance of the system to deque.
	 * @param {string} [groupName] - Optional. The specific update group to remove from. If not provided,
	 *                               the group is inferred.
	 * @returns {boolean} True if the system was found and removed, false otherwise.
	 */
	dequeSystem(systemToDeque, groupName) {
		const systemInstance = this._getSystemInstance(systemToDeque, false)
		if (!systemInstance) return false

		const group = groupName ? this.updateGroups[groupName] : this._getSystemGroupFor(systemInstance)
		if (!group) {
			console.warn(
				`SystemManager: Cannot deque system "${systemInstance.constructor.name}". No valid group found or specified.`
			)
			return false
		}

		const index = group.systems.indexOf(systemInstance)
		if (index > -1) {
			group.systems.splice(index, 1)
			this._updateGroupReactivity(group)

			return true
		}

		return false
	}

	/**
	 * Sets the desired update frequency for a specific system.
	 * This method centralizes performance-related configuration.
	 * @param {string} systemName - The class name of the system to configure. * @param {number|'logic'|'visuals'|'input'} frequency - The desired update frequency.
	 * - `number`: Target updates per second (e.g., 10 for 10 FPS).
	 * - `'logic'`: Runs in the fixed-step logic/physics loop.
	 * - `'visuals'`: Runs every visual frame, receiving the `alpha` interpolation value.
	 * - `'input'`: Runs first in the frame for low-latency input.
	 */
	setUpdateFrequency(systemName, frequency) {
		const SystemClass = systemRegistry.getSystemClass(systemName)
		if (!SystemClass) {
			console.warn(`SystemManager: System class "${systemName}" not found. Cannot set update frequency.`)
			return
		}

		if (typeof frequency === 'number' && frequency > 0) {
			const groupName = `${frequency}Fps`
			this._ensureTimedGroupExists(groupName, frequency)
			this._systemConfig.set(SystemClass, { frequency, groupName })
		} else if (frequency === 'logic' || frequency === 'visuals' || frequency === 'input') {
			const groupName = frequency
			this._systemConfig.set(SystemClass, { frequency, groupName })
		} else if (frequency === 'none') {
			// 'none' systems are not added to any update group, so groupName is null.
			this._systemConfig.set(SystemClass, { frequency, groupName: null })
		} else {
			console.warn(`SystemManager: Invalid frequency "${frequency}" for system ${systemName}.`)
		}
	}

	/**
	 * Ensures a timed update group for a specific FPS exists. If not, it creates one.
	 * @param {string} groupName - The name of the group (e.g., 'on10Fps').
	 * @param {number} fps - The target frames per second for this group.
	 * @private
	 */
	_ensureTimedGroupExists(groupName, fps) {
		if (!this.updateGroups[groupName]) {
			const newGroup = {
				name: groupName,
				systems: [],
				hasChangedSystem: false,
				interval: 1 / fps,
				accumulator: 0,
				lastTick: -1,
			}
			this.updateGroups[groupName] = newGroup
		}
	}

	/**
	 * Dynamically adds a new system to the engine at runtime.
	 * @param {Function} SystemClass - The class of the system to add.
	 * @param {object} options - Configuration for the new system. * @param {'logic'|'visuals'|'input'|number} options.frequency - The update frequency. * @param {string} [options.before] - The name of an existing system to insert this one before.
	 * @param {string} [options.after] - The name of an existing system to insert this one after.
	 */
	async addSystem(SystemClass, options = {}) {
		const { frequency, before, after } = options
		const systemName = SystemClass.name

		if (!frequency) {
			console.error(`SystemManager.addSystem: Frequency is required to add system "${systemName}".`)
			return
		}

		// 1. Register, instantiate, and initialize the system
		if (!systemRegistry.getSystemClass(systemName)) {
			systemRegistry.systemClasses.set(systemName, SystemClass)
		}
		const systemInstance = systemRegistry.instantiateSystem(systemName)
		if (!systemInstance) {
			console.error(`Failed to instantiate and add system ${systemName}`)
			return
		}
		systemInstance.commands = this.commandBuffer
		await systemInstance.init?.()

		// 2. Configure its update frequency
		this.setUpdateFrequency(systemName, frequency)

		// 3. Insert it into the execution order using the Sequence
		let inserted = false
		if (before) {
			const index = this._executionOrder.findIndex(s => s === before)
			if (index !== -1) {
				this._executionOrder.insertBefore(systemName, index)
				inserted = true
			} else {
				console.error(`Could not find system "${before}" to insert "${systemName}" before. Appending to end.`)
			}
		} else if (after) {
			const index = this._executionOrder.findIndex(s => s === after)
			if (index !== -1) {
				this._executionOrder.insertAfter(systemName, index)
				inserted = true
			} else {
				console.error(`Could not find system "${after}" to insert "${systemName}" after. Appending to end.`)
			}
		}

		if (!inserted) {
			this._executionOrder.insert(systemName) // Add to the end by default
		}

		// 4. Update caches, queue the system, and re-sort all groups
		this._rebuildExecutionOrderMap()
		this.queSystem(systemName) // This adds it to the correct update group
		this._sortAllGroups() // Re-sort all groups as the global order has changed
	}

	/**
	 * Validates the system configuration to catch common errors at startup.
	 * 1. Warns if a system in the execution order has no frequency set (will default to 'render').
	 * 2. Errors if a system has a frequency set but is not in the execution order (will not run).
	 * @private
	 */
	_validateSystemConfiguration() {
		const executionOrderSet = new Set(this._executionOrder)

		// 1. Check if all systems in the execution order have a frequency configured.
		for (const systemName of this._executionOrder) {
			const SystemClass = systemRegistry.getSystemClass(systemName)
			if (SystemClass && !this._systemConfig.has(SystemClass)) {
				console.warn(
					`SystemManager Validation: System "${systemName}" is in the execution order but has no frequency configured in systemConfig.js. ` +
						`It will default to the 'visuals' update group.`
				)
			}
		}

		// 2. Check if all configured systems are actually in the execution order.
		for (const SystemClass of this._systemConfig.keys()) {
			if (!executionOrderSet.has(SystemClass.name)) {
				// This check is less critical now as config is unified, but kept for robustness.
				console.error(
					`SystemManager Validation: System "${SystemClass.name}" has a frequency configured but is NOT listed in the 'systemSchedule' execution order in systemConfig.js. ` +
						`This system will not be queued and will NOT run.`
				)
			}
		}
	}

	/**
	 * Rebuilds the execution order map from the sequence.
	 * This is a performance cache to make sorting fast.
	 * @private
	 */
	_rebuildExecutionOrderMap() {
		this._executionOrderMap.clear()
		this._executionOrder.forEach((name, index) => this._executionOrderMap.set(name, index))
	}

	_getSystemQueries(system, out = []) {
		for (const key in system) {
			const prop = system[key]
			if (prop instanceof Query) {
				out.push(prop)
			}
		}
		return out
	}

	_getReactiveQueries(system, out = []) {
		for (const key in system) {
			const prop = system[key]
			if (prop instanceof Query && prop.isReactiveQuery) {
				out.push(prop)
			}
		}
		return out
	}

	/**
	 * "Primes" a system's reactive queries with the correct last tick.
	 * This is a performance-critical helper called just before a system's update.
	 * @param {object} system The system to prime.
	 * @param {number} lastTick The last tick of the system's group.
	 * @private
	 */
	_primeSystemQueries(system, lastTick) {
		// This check is extremely fast as `reactive` is a pre-cached boolean.
		if (system.reactive) {
			// This loop is also fast as `reactiveQueries` is a pre-cached array.
			for (const query of system.reactiveQueries) {
				query.iterationLastTick = lastTick
			}
		}
	}

	/**
	 * Unregisters a system instance from the manager.
	 * The system must be de-queued from all update groups before it can be unregistered.
	 * @param {object|string} systemOrName - The system instance or its class name to unregister.
	 * @returns {boolean} True if the system was found and unregistered, false otherwise.
	 */
	unregisterSystem(systemOrName) {
		const systemInstance = this._getSystemInstance(systemOrName, false)
		if (!systemInstance) {
			return false
		}
		const systemName = systemInstance.constructor.name

		// Check if the system is currently queued in any update group.
		for (const group of Object.values(this.updateGroups)) {
			if (group.systems.includes(systemInstance)) {
				console.warn(
					`SystemManager: Cannot unregister system "${systemName}". It is still queued for execution. Call dequeSystem() first.`
				)
				return false
			}
		}

		// This is crucial for cleaning up resources like mutable queries.
		systemInstance.destroy?.()

		// Delegate unregistration to the central registry
		return systemRegistry.unregisterSystem(systemName)
	}

	/**
	 * Gets an instance of a system from the registry.
	 * @param {string|object} systemNameOrInstance - The name or instance of the system.
	 * @param {boolean} shouldWarn - Whether to warn if the system is not found.
	 * @returns {object|null} The system instance or null if not found.
	 * @private
	 */
	_getSystemInstance(systemNameOrInstance, shouldWarn = true) {
		if (typeof systemNameOrInstance === 'string') {
			const instance = systemRegistry.getSystem(systemNameOrInstance)
			if (!instance && shouldWarn) {
				console.warn(`SystemManager: System instance "${systemNameOrInstance}" not found in registry.`)
			}
			return instance
		}
		return systemNameOrInstance
	}

	/**
	 * Gets the name of a system.
	 * @param {string|object} systemNameOrInstance - The name or instance of the system.
	 * @returns {string|null} The system name or null if invalid.
	 * @private
	 */
	_getSystemName(systemNameOrInstance) {
		if (typeof systemNameOrInstance === 'string') {
			return systemNameOrInstance
		}
		return systemNameOrInstance?.constructor.name
	}

	/**
	 * Finds the update group a system instance belongs to based on its configuration.
	 * @param {object} systemInstance - The system instance.
	 * @returns {object|null} The update group or null if not found.
	 * @private
	 */
	_getSystemGroupFor(systemInstance) {
		const config = this._systemConfig.get(systemInstance.constructor)
		// Default to 'visuals' if no specific frequency is configured.
		const groupName = config ? config.groupName : 'visuals'
		return this.updateGroups[groupName] || null
	}

	/**
	 * Ensures a system is checked for reactive queries and its `reactive` property is set.
	 * This is done once per system instance.
	 * @param {object} systemInstance - The system instance to prime.
	 * @private
	 */
	_primeSystem(systemInstance) {
		if (systemInstance.reactive === undefined) {
			// Check if not already primed
			const reactiveQueries = this._getReactiveQueries(systemInstance)
			if (reactiveQueries.length > 0) {
				systemInstance.reactiveQueries = reactiveQueries
				systemInstance.reactive = true
			} else {
				systemInstance.reactive = false
			}
		}
	}

	/**
	 * Updates a group's `hasChangedSystem` flag based on the reactivity of its current systems.
	 * @param {object} group - The update group to check.
	 * @private
	 */
	_updateGroupReactivity(group) {
		group.hasChangedSystem = group.systems.some(s => s.reactive)
	}

	/**
	 * Sorts the systems within a single group based on the execution order map.
	 * ### Implementation Choice: `Array.prototype.sort()` vs. Insertion Sort for a bit more safety.
	 * @param {object} group - The update group to sort.
	 * @private
	 */
	_sortGroup(group) {
		group.systems.sort((a, b) => {
			const nameA = a.constructor.name
			const nameB = b.constructor.name
			const indexA = this._executionOrderMap.get(nameA) ?? Infinity
			const indexB = this._executionOrderMap.get(nameB) ?? Infinity

			return indexA - indexB
		})
	}

	/**
	 * Sorts all update groups. Necessary when the global execution order changes.
	 * @private
	 */
	_sortAllGroups() {
		for (const group of Object.values(this.updateGroups)) {
			this._sortGroup(group)
		}
	}

	/**
	 * Destroys the SystemManager and cleans up its resources.
	 */
	destroy() {
		this.gameLoop.destroy() // First, destroy all managed systems to allow them to clean up their resources.
		for (const systemInstance of systemRegistry.systemInstances.values()) {
			try {
				systemInstance.destroy?.()
			} catch (error) {
				console.error(`Error destroying system ${systemInstance.constructor.name}:`, error)
			}
		}
		systemRegistry.clear()
		this.updateGroups = {}
		this._systemConfig.clear()
	}
}

export const systemManager = new SystemManager()
