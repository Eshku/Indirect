const { extensions: systemExtensions } = await import('../../Core/Extends/systemExtends.js')
const { eventEmitter } = await import(`@core/Classes/EventEmitter.js`)

import { GameLoop } from './GameLoop.js'
import { loadAllSystems } from './systemLoader.js'
import { loadAllKernels } from './kernelLoader.js'
import { kernelRegistry } from './KernelRegistry.js'
import { systemRegistry } from './SystemRegistry.js'

import { releaseSystemQueries } from './systemUtils.js'
import { toCamelCase } from '../../Core/utils/stringUtils.js'

import { systemSchedule } from './systemConfig.js'
import { importFromString } from '../../Core/utils/blob.js'
import { entityCommandBuffer } from './EntityCommandBuffer.js'
import { CommandBufferExecutor } from './CommandBufferExecutor.js'

import { payloadCompiler } from './PayloadCompiler.js'

const { Sequence } = await import(`@core/DataStructures/Sequence.js`)
const { Query } = await import(`@managers/QueryManager/Query.js`)

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
	async init(engine) {
		this.entityCommandBuffer = entityCommandBuffer

		this.systemTimings = {}

		// A flat list of all system names to be managed, derived from systemConfig.js.
		this._systemList = new Sequence()

		// This will store the configuration for each system's update rate.
		// Map<SystemClass, { frequency: number | 'fixed' | 'update', groupName: string }>
		this._systemConfig = new Map()

		// Caches pre-analyzed static metadata for each system class.
		this.systemMetadataCache = new Map()

		// Caches the filtered, structured context objects for fast lookups and worker distribution. This cache is
		// built once during initialization (`_buildAndCacheSystemContexts`) and updated during HMR. It provides
		// O(1) access to a kernel's context, avoiding repeated metadata lookups during job execution on both the
		// main thread and workers.
		this.allSystemContexts = {}

		// --- Persistent System ID Mapping ---
		this.systemIdCounter = 0
		this.systemNameToId = new Map()
		this.idToSystemName = new Map()

		this.hmrListenerId = null

		this.updateGroups = {
			// Runs first for low-latency user input.
			input: { name: 'input', systems: [], lastTick: -1 },
			// Runs on a fixed, deterministic timer for core gameplay logic and physics.
			logic: { name: 'logic', systems: [], lastTick: -1 },
			// Runs once per visual frame for rendering, interpolation, and UI.
			visuals: { name: 'visuals', systems: [], lastTick: -1 },

			//placeholder, last tick will be synced with GameLoop
		}

		this.gameLoop = new GameLoop()

		// Sync the initial lastTick for all predefined groups from the GameLoop.
		// This ensures a single source of truth for starting tick values.
		for (const groupName in this.updateGroups) {
			if (Object.prototype.hasOwnProperty.call(this.updateGroups, groupName)) {
				this.updateGroups[groupName].lastTick = this.gameLoop.lastTick
			}
		}

		this.entityManager = engine.entityManager
		this.componentManager = engine.componentManager
		this.queryManager = engine.queryManager
		this.prefabManager = engine.prefabManager
		this.workerManager = engine.workerManager
		this.entityMaskManager = engine.entityMaskManager

		this.app = engine.gameManager.getApp()
		this.renderer = this.app.renderer
		this.ticker = this.app.ticker

		this.entityCommandBuffer.init(engine)

		this.commandBufferExecutor = new CommandBufferExecutor(this.entityManager, this.entityMaskManager)

		// --- Phase 1: Discovery & ID Assignment (No Imports) ---
		const [systemFileTree, kernelFileTree] = await Promise.all([
			window.electronAPI.getSystemTree(),
			window.electronAPI.getKernelTree(),
		])

		const systemNames = Object.values(systemFileTree).flat()
		const kernelFileNames = kernelFileTree || []
		const kernelNames = kernelFileNames.map(fileName => toCamelCase(fileName.replace('.js', '')))

		this._assignAllIdsFromNames(systemNames, kernelNames)
		this._createIdObjects()

		// --- Phase 2: Module Loading & Registration ---
		const systemModules = new Map()
		for (const category in systemFileTree) {
			for (const moduleName of systemFileTree[category]) {
				const modulePath = `@systems/${category}/${moduleName}.js`
				const module = await import(modulePath)
				systemModules.set(moduleName, module)
			}
		}

		const { loadedModules: kernelModules, kernelCode } = await loadAllKernels(kernelFileTree)

		systemRegistry.registerSystemClasses(systemModules)
		kernelRegistry.registerKernelModules(kernelModules, kernelCode, this.workerManager)

		// --- Analysis Step ---
		this._analyzeAndCacheSystems()

		// --- Configuration Step ---
		// Get the single, flattened list of systems from the new group-based config.
		this._defineSystemList()
		this._configureSystemFrequencies()

		this._validateSystemConfiguration()
		await this.gameLoop.init(engine)
	}

	/**
	 * Calls the init method on all systems defined in the execution order.
	 * This is intended to be called once after all initial entities and setup are complete,
	 * but before the main game loop begins.
	 */
	async initAll() {
		// Instantiate and initialize systems based on the execution order.
		for (const systemName of this._systemList) {
			const systemInstance = systemRegistry.instantiateSystem(systemName)
			if (systemInstance) {
				// Assign custom user-defined extensions from systemExtends.js.
				Object.assign(systemInstance, systemExtensions)

				await systemInstance.init?.()
			} else {
				// This might happen if a system is in the order but fails to load/register.
				console.warn(`SystemManager: System "${systemName}" in executionOrder not found during initAll().`)
			}
		}

		// Now that all systems are instantiated and initialized, queue them for execution.
		this.queAll(this._systemList)

		// Sort all groups to enforce the canonical execution order.
		this._sortAllGroups()

		// Build the fast-access context cache now that all systems are instantiated.
		this._buildAndCacheSystemContexts()

		// Send the initial, static context data for all parallel systems to the workers.
		// The workerManager will pull the cached contexts from this manager.
		this.workerManager.broadcastInitialSystemContexts()
	}

	/**
	 * Retrieves an object mapping all registered system names to their numeric IDs.
	 * This is ideal for destructuring in a system's static properties for clean, cached access.
	 * @returns {Object.<string, number>} An object mapping system names to their IDs.
	 */
	getSystemIds() {
		return this._systemIdObject
	}

	/**
	 * Retrieves the pre-compiled, structured object containing all kernel contexts.
	 * @returns {Object.<number, Object.<number, object>>}
	 */
	getSystemContexts() {
		return this.allSystemContexts
	}

	/**
	 * Retrieves an object mapping all registered kernel names to their numeric IDs.
	 * @returns {Object.<string, number>} An object mapping kernel names to their IDs.
	 */
	getKernelIds() {
		return kernelRegistry.getKernelIds() // Delegate to the registry
	}

	/**
	 * Creates the final, frozen objects for ID access.
	 * This is called after all IDs have been assigned from filenames.
	 * @private
	 */
	_createIdObjects() {
		this._systemIdObject = Object.fromEntries(this.systemNameToId)
		this.workerManager.addInitialResource('systemIdMap', this._systemIdObject)

		// Also trigger the creation in the kernel registry
		kernelRegistry.setKernelIdObject()
	}
	/**
	 * Clears the system timings object. Called by the GameLoop once per frame.
	 */
	clearSystemTimings() {
		this.systemTimings = {}
	}

	queAll(systemList) {
		for (const systemName of systemList) {
			if (systemRegistry.getSystem(systemName)) {
				this.queSystem(systemName)
			}
		}
	}

	/**
	 * Defines the final, flattened list of systems to run from the
	 * `systemSchedule` configuration. This is the single source of truth for both
	 * initialization and for determining which systems are active. This populates
	 * the internal `_systemList` sequence.
	 * @private
	 */
	_defineSystemList() {
		this._systemList.clear()
		const allSystemNames = new Set()

		for (const groupName of Object.keys(systemSchedule)) {
			const systemList = systemSchedule[groupName]
			if (Array.isArray(systemList)) {
				for (const systemConfig of systemList) {
					allSystemNames.add(systemConfig.name)
				}
			}
		}

		// The order of systems in `systemSchedule` now defines the initialization order.
		// We iterate through the groups and systems as defined in the config file
		// to build a list that respects that explicit ordering.
		for (const groupName of Object.keys(systemSchedule)) {
			const systemList = systemSchedule[groupName]
			if (Array.isArray(systemList)) {
				for (const systemConfig of systemList) {
					if (allSystemNames.has(systemConfig.name)) {
						this._systemList.insert(systemConfig.name)
					}
				}
			}
		}
	}

	/**
	 * Analyzes all registered system classes for their static metadata (`runsAfter`,
	 * `dependencies`, methods) and caches it for fast access by the Scheduler.
	 * This is a one-time operation performed at initialization.
	 * @private
	 */
	_analyzeAndCacheSystems() {
		this.systemMetadataCache.clear()
		this._buildInitialMetadata()
		this._resolveAndValidateControlFlow()
	}

	/**
	 * Assigns persistent, unique integer IDs to every system and kernel NAME.
	 * This is the core of the new "no-magic" loading strategy.
	 * @param {string[]} systemNames
	 * @param {string[]} kernelNames
	 * @private
	 */
	_assignAllIdsFromNames(systemNames, kernelNames) {
		this.systemIdCounter = 0
		this.systemNameToId.clear()
		this.idToSystemName.clear()
		for (const systemName of systemNames) {
			this._assignSystemId(systemName)
		}

		for (const kernelName of kernelNames) {
			kernelRegistry.assignKernelId(kernelName)
		}
	}

	/**
	 * Second analysis pass: Builds the initial metadata for each system.
	 * It extracts data dependencies and stores raw control-flow dependency names for a later pass.
	 * @private
	 */
	_buildInitialMetadata() {
		for (const [systemName, SystemClass] of systemRegistry.systemClasses.entries()) {
			const metadata = {
				id: this.getSystemId(systemName),
				name: systemName,
				// The 'schedule' method is now exclusively for creating jobs (the "Job Factory").
				hasSchedule: !!SystemClass.prototype.schedule,
				hasUpdate: !!SystemClass.prototype.update, // This is a boolean, not a method reference.
				hasProcess: !!SystemClass.prototype.process,
				dependencies: this._analyzeSystemDependencies(SystemClass, systemName), // This will now return a Map
				// --- DX : Normalize single values to arrays ---
				runsAfter: SystemClass.runsAfter
					? Array.isArray(SystemClass.runsAfter)
						? SystemClass.runsAfter
						: [SystemClass.runsAfter]
					: [],
				runsBefore: SystemClass.runsBefore
					? Array.isArray(SystemClass.runsBefore)
						? SystemClass.runsBefore
						: [SystemClass.runsBefore]
					: [],
				// Final ID arrays will be populated in the next pass.
			}
			// The cache is now keyed by the numeric system ID for fast lookups in the Scheduler.
			this.systemMetadataCache.set(metadata.id, metadata)
		}
	}

	/**
	 * Extracts and translates `reads`/`writes` component dependencies from a system class into type IDs.
	 * This is a helper method for the analysis pass.
	 * @param {Function} SystemClass The system class to analyze.
	 * @param {string} systemName The name of the system for logging.
	 * @returns {object} The structured dependency object with sets of component IDs.
	 * @private
	 */
	_analyzeSystemDependencies(SystemClass, systemName) {
		// The dependency map is now keyed by numeric IDs (kernelId or JOB_TYPE) for performance.
		const finalDependencies = new Map()

		const dependencies = SystemClass.dependencies
		if (dependencies) {
			// Iterate over all declared dependency keys (e.g., 'update', 'process', 'myKernel').
			for (const methodName in dependencies) {
				const methodDeps = dependencies[methodName]
				if (typeof methodDeps !== 'object' || methodDeps === null || Array.isArray(methodDeps)) {
					continue
				}
				let key

				// Translate the string method/kernel name into a numeric ID.
				if (methodName === 'update') {
					key = 0 // JOB_TYPE.UPDATE
				} else if (methodName === 'process') {
					key = 2 // JOB_TYPE.PROCESS
				} else {
					key = kernelRegistry.kernelNameToId.get(methodName)
					if (key === undefined) {
						console.warn(
							`[SystemManager] System "${systemName}" has dependencies for an unknown kernel "${methodName}".`,
						)
						continue
					}
				}

				// --- DX Improvement: Normalize single values to arrays ---
				const reads = methodDeps.reads ? (Array.isArray(methodDeps.reads) ? methodDeps.reads : [methodDeps.reads]) : []
				const writes = methodDeps.writes
					? Array.isArray(methodDeps.writes)
						? methodDeps.writes
						: [methodDeps.writes]
					: []

				const newMethodDeps = {
					reads: new Set(),
					writes: new Set(),
				}

				reads.forEach(typeId => {
					if (Number.isInteger(typeId)) {
						newMethodDeps.reads.add(typeId)
					} else {
						console.warn(
							`[SystemManager] System "${systemName}" has a non-numeric read dependency in method "${methodName}": ${typeId}. Dependencies must be numeric component TypeIDs.`,
						)
					}
				})

				writes.forEach(typeId => {
					if (Number.isInteger(typeId)) {
						newMethodDeps.writes.add(typeId)
					} else {
						console.warn(
							`[SystemManager] System "${systemName}" has a non-numeric write dependency in method "${methodName}": ${typeId}. Dependencies must be numeric component TypeIDs.`,
						)
					}
				})

				if (methodDeps.context) {
					const contextDef = methodDeps.context
					// Validate that the context is a plain object. The function-based "Context Factory"
					// and legacy array-based patterns are now deprecated and will be caught here.
					if (typeof contextDef !== 'object' || contextDef === null || Array.isArray(contextDef)) {
						console.error(
							`[SystemManager] System "${systemName}" method/kernel "${methodName}" has an invalid context definition. ` +
								`Context must be a plain object.`,
						)
						// Assign an empty context to prevent further errors down the line.
						newMethodDeps.context = {}
					} else {
						newMethodDeps.context = contextDef
					}
				}

				finalDependencies.set(key, newMethodDeps)
			}
		}
		return finalDependencies
	}

	/**
	 * Third and final analysis pass: Resolves all control-flow dependencies.
	 * It translates `runsAfter` and `runsBefore` names to IDs, merges `runsBefore`
	 * into the `runsAfter` lists of target systems, and validates against conflicts.
	 * @private
	 */
	_resolveAndValidateControlFlow() {
		const validateDependencyId = (id, sourceSystemName) => {
			if (typeof id !== 'number') {
				console.warn(
					`[SystemManager] System "${sourceSystemName}" has an invalid dependency value "${id}" (type: ${typeof id}). ` +
						`Dependencies must be numeric System IDs (e.g., from ecs.getSystemIDs()).`,
				)
				return undefined
			}
			// Validate that the numeric ID is a known system.
			if (!this.idToSystemName.has(id)) {
				console.warn(
					`[SystemManager] System "${sourceSystemName}" declares a dependency on an unknown numeric ID "${id}". ` +
						`Ensure it's a valid System ID.`,
				)
				return undefined
			}
			return id
		}

		// First pass: Validate all dependency IDs within the cached metadata.
		for (const metadata of this.systemMetadataCache.values()) {
			const sourceSystemName = metadata.name // Get the system's name for improved error messages
			metadata.runsAfter = (metadata.runsAfter || [])
				.map(id => validateDependencyId(id, sourceSystemName))
				.filter(id => id !== undefined)
			metadata.runsBefore = (metadata.runsBefore || [])
				.map(id => validateDependencyId(id, sourceSystemName))
				.filter(id => id !== undefined)
		}

		// Second pass: process `runsBefore` and check for conflicts, now with real IDs.
		for (const [sourceSystemId, sourceMetadata] of this.systemMetadataCache.entries()) {
			if (!sourceMetadata.runsBefore || sourceMetadata.runsBefore.length === 0) continue

			for (const targetSystemId of sourceMetadata.runsBefore) {
				// targetSystemId is already a number
				const targetMetadata = this.systemMetadataCache.get(targetSystemId) // Use ID directly
				const sourceSystemName = this.idToSystemName.get(sourceSystemId)
				const targetSystemName = this.idToSystemName.get(targetSystemId)

				if (targetMetadata) {
					// CONFLICT CHECK 1: A runsBefore B, but also A runsAfter B.
					if (sourceMetadata.runsAfter.includes(targetSystemId)) {
						throw new Error(
							`[SystemManager] Conflicting dependencies on "${sourceSystemName}": it is declared to run both BEFORE and AFTER "${targetSystemName}".`,
						)
					}

					// CONFLICT CHECK 2: A runsBefore B, but also B runsBefore A.
					if (targetMetadata.runsBefore.includes(sourceMetadata.id)) {
						throw new Error(
							`[SystemManager] Circular dependency detected: "${sourceSystemName}" runs BEFORE "${targetSystemName}", and "${targetSystemName}" runs BEFORE "${sourceSystemName}".`,
						)
					}

					// Add the inverse dependency: `target` runs after `source`.
					if (!targetMetadata.runsAfter.includes(sourceMetadata.id)) {
						targetMetadata.runsAfter.push(sourceMetadata.id)
					}
				} else {
					console.warn(
						`[SystemManager] System "${sourceSystemName}" has a 'runsBefore' dependency on an unknown system ID "${targetSystemId}".`,
					)
				}
			}
			// After processing, we can clear the runsBefore array as it's been merged.
			sourceMetadata.runsBefore = []
		}
	}

	/**
	 * Assigns a persistent, unique integer ID to a system name if it doesn't have one.
	 * @param {string} systemName - The name of the system.
	 * @private
	 */
	_assignSystemId(systemName) {
		if (!this.systemNameToId.has(systemName)) {
			const id = this.systemIdCounter++
			this.systemNameToId.set(systemName, id)
			this.idToSystemName.set(id, systemName)
		}
	}

	/**
	 * Configures update frequencies for all game systems based on the schedule.
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
				`SystemManager: Cannot que system "${systemInstance.constructor.name}". No valid group found or specified.`,
			)
			return false
		}

		//console.log(`[SystemManager] Queuing system "${systemInstance.constructor.name}" into group "${group.name}"`)

		if (group.systems.includes(systemInstance)) {
			// It's already in the group, no need to add it again.
			return true
		}

		this._primeSystem(systemInstance)
		group.systems.push(systemInstance)

		return true
	}

	/**
	 * Deques a system from execution.
	 * @param {string|object} systemToDeque - The name or instance of the system to deque.
	 * @param {string} [groupName] - Optional. The specific update group to remove from. If not provided,
	 *
	 * @returns {boolean} True if the system was found and removed, false otherwise.
	 */
	dequeSystem(systemToDeque, groupName) {
		const systemInstance = this._getSystemInstance(systemToDeque, false)
		if (!systemInstance) return false

		const group = groupName ? this.updateGroups[groupName] : this._getSystemGroupFor(systemInstance)
		if (!group) {
			console.warn(
				`SystemManager: Cannot deque system "${systemInstance.constructor.name}". No valid group found or specified.`,
			)
			return false
		}

		const index = group.systems.indexOf(systemInstance)
		if (index > -1) {
			group.systems.splice(index, 1)
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
				interval: 1 / fps,
				accumulator: 0,
				lastTick: this.gameLoop.lastTick,
			}
			this.updateGroups[groupName] = newGroup
		}
	}

	/**
	 * Dynamically adds a new system to the engine at runtime. This is a complex operation
	 * that involves pausing the game loop, re-analyzing system dependencies, and updating
	 * execution orders.
	 * @param {Function} SystemClass - The class of the system to add.
	 * @param {object} options - Configuration for the new system.
	 * @param {'logic'|'visuals'|'input'|number} options.frequency - The update frequency.
	 * @param {string} [options.before] - The name of an existing system to insert this one before.
	 * @param {string} [options.after] - The name of an existing system to insert this one after.
	 */
	async addSystem(SystemClass, options = {}) {
		const { frequency, before, after } = options
		const systemName = SystemClass.name

		if (!frequency) {
			console.error(`[SystemManager] addSystem: Frequency is required to add system "${systemName}".`)
			return
		}

		// --- Synchronization: Pause the world to safely add the system ---
		this.gameLoop.pause()

		// 1. Register the new class and re-run analysis to generate metadata for the scheduler.
		if (!systemRegistry.getSystemClass(systemName)) {
			systemRegistry.systemClasses.set(systemName, SystemClass)
		}
		this._analyzeAndCacheSystems() // This is crucial for the scheduler.

		// 2. Instantiate and initialize the system.
		const systemInstance = systemRegistry.instantiateSystem(systemName)
		if (!systemInstance) {
			console.error(`[SystemManager] Failed to instantiate and add system ${systemName}.`)
			this.gameLoop.resume() // Resume on failure.
			return
		}

		await systemInstance.init?.()

		// Let the performance monitor know about the new system.
		const perfMon = systemRegistry.getSystem('PerformanceMonitor')
		perfMon?.trackSystem(systemName)

		// 3. Configure its update frequency.
		this.setUpdateFrequency(systemName, frequency)

		// 4. Insert it into the global execution order list.
		// NOTE: Assumes _systemList is an array-like object that supports splice/findIndex.
		let inserted = false
		if (before) {
			const index = this._systemList.findIndex(s => s === before)
			if (index !== -1) {
				this._systemList.splice(index, 0, systemName)
				inserted = true
			} else {
				console.error(
					`[SystemManager] Could not find system "${before}" to insert "${systemName}" before. Appending to end.`,
				)
			}
		} else if (after) {
			const index = this._systemList.findIndex(s => s === after)
			if (index !== -1) {
				this._systemList.splice(index + 1, 0, systemName)
				inserted = true
			} else {
				console.error(
					`[SystemManager] Could not find system "${after}" to insert "${systemName}" after. Appending to end.`,
				)
			}
		}

		if (!inserted) {
			this._systemList.insert(systemName) // Add to the end by default
		}

		// 5. Queue the system into its correct update group.
		this.queSystem(systemName) // This adds it to the correct update group

		// 6. Re-sort all groups to respect the new global order.
		this._sortAllGroups()

		// 7. Let workers know about the new system's context if it's parallel.
		this.workerManager.broadcastInitialSystemContexts(this) // This re-broadcasts all contexts, which is safe.

		console.log(`[SystemManager] Dynamically added system: ${systemName}`)

		this.gameLoop.resume()
	}

	/**
	 * Validates the system configuration to catch common errors at startup.
	 * 1. Warns if a system in the execution order has no frequency set (will default to 'render').
	 * 2. Errors if a system has a frequency set but is not in the execution order (will not run).
	 * @private
	 */
	_validateSystemConfiguration() {
		const systemListSet = new Set(this._systemList)

		// 1. Check if all systems in the execution order have a frequency configured.
		for (const systemName of this._systemList) {
			const SystemClass = systemRegistry.getSystemClass(systemName)
			if (SystemClass && !this._systemConfig.has(SystemClass)) {
				console.warn(
					`SystemManager Validation: System "${systemName}" is in the execution order but has no frequency configured in systemConfig.js. ` +
						`It will default to the 'visuals' update group.`,
				)
			}
		}

		// 2. Check if all configured systems are actually in the execution order.
		for (const SystemClass of this._systemConfig.keys()) {
			if (!systemListSet.has(SystemClass.name)) {
				// This check is less critical now as config is unified, but kept for robustness.
				console.error(
					`SystemManager Validation: System "${SystemClass.name}" has a frequency configured but is NOT listed in the 'systemSchedule' execution order in systemConfig.js. ` +
						`This system will not be queued and will NOT run.`,
				)
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
					`SystemManager: Cannot unregister system "${systemName}". It is still queued for execution. Call dequeSystem() first.`,
				)
				return false
			}
		}

		// This is crucial for cleaning up resources like mutable queries.
		// First, perform the automatic query cleanup.
		releaseSystemQueries(systemInstance)
		// Then, call the system's own optional destroy method for any custom cleanup.
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
			const reactiveQueries = []
			for (const key in systemInstance) {
				const prop = systemInstance[key]
				if (prop instanceof Query && prop.isReactiveQuery) {
					reactiveQueries.push(prop)
				}
			}

			if (reactiveQueries.length > 0) {
				systemInstance.reactiveQueries = reactiveQueries
				systemInstance.reactive = true
			} else {
				systemInstance.reactive = false
			}
		}
	}

	/**
	 * Sorts all update groups based on the global execution order in _systemList.
	 * This is necessary after the global order changes, e.g., after adding a system.
	 * @private
	 */
	_sortAllGroups() {
		// Create a map for O(1) lookup of a system's global order.
		const systemOrderMap = new Map(this._systemList.map((name, index) => [name, index]))
		for (const group of Object.values(this.updateGroups)) {
			group.systems.sort((a, b) => {
				const orderA = systemOrderMap.get(a.constructor.name)
				const orderB = systemOrderMap.get(b.constructor.name)
				// Handle cases where a system might not be in the map (shouldn't happen in normal flow).
				if (orderA === undefined || orderB === undefined) return 0
				return orderA - orderB
			})
		}
	}

	/**
	 * Implements Hot Module Replacement for a single system.
	 * This method gracefully destroys the old system instance and injects a new one
	 * created from the provided code string, without requiring a page reload.
	 *
	 * @param {string} systemPath - The relative path of the system file (e.g., 'Test/MySystem.js').
	 * @param {string} newCode - The transpiled JavaScript code for the new system module.
	 */
	async hotSwapModule(systemPath, newCode) {
		// --- HMR Synchronization: Stop the World ---
		this.gameLoop.pause()

		const systemName = systemPath.split('/').pop().replace('.js', '')

		// --- HMR Resilience ---
		// Check if the system is supposed to be running, even if it's not currently instantiated
		// due to a previous HMR error. We check against the original system list.
		const isKnownSystem = this._systemList.includes(systemName)

		const oldInstance = systemRegistry.getSystem(systemName)
		if (!oldInstance && !isKnownSystem) {
			console.error(`[HMR] Cannot hot-swap: System "${systemName}" is not a known or running system.`)
			// Resume the loop if we abort early.
			this.gameLoop.resume()
			return
		}

		if (oldInstance) {
			// 1. De-queue the old system, but only if it's actually in an update group.
			// Systems with frequency 'none' are not in any group.
			const config = this._systemConfig.get(oldInstance.constructor)
			if (config?.frequency !== 'none') {
				this.dequeSystem(systemName)
			}

			// 2. Unregister the old system, which calls its destroy() method to clean up queries.
			// This will now succeed because the system has either been de-queued or was never in a group.
			this.unregisterSystem(systemName)
		}

		// 3. Load the new code string as a JavaScript module using our HMR utility.
		let NewSystemClass
		let newModule

		try {
			newModule = await importFromString(newCode)
			NewSystemClass = newModule[systemName]

			if (!NewSystemClass) {
				throw new Error(`Module did not export a class named "${systemName}".`)
			}
		} catch (error) {
			console.error(`[HMR] Failed to import new module for ${systemName}:`, error)
			// The system is now de-queued and unregistered. The next successful HMR
			// for this file will correctly re-add it because of the `isKnownSystem` check.
			// Resume the loop on failure.
			this.gameLoop.resume()
			return
		}

		// 4. Register the new class, create a new instance, and initialize it.
		// We also need to re-analyze and cache its metadata.
		systemRegistry.systemClasses.set(systemName, NewSystemClass)
		this._analyzeAndCacheSystems() // Re-run analysis to include the new class.

		systemRegistry.systemClasses.set(systemName, NewSystemClass)
		const newInstance = systemRegistry.instantiateSystem(systemName)
		if (!newInstance) {
			console.error(`[HMR] Failed to instantiate new version of ${systemName}.`)
			// Resume the loop on failure.
			this.gameLoop.resume()
			return
		}

		// --- Extend New System Instance ---
		// Assign core engine properties and custom user-defined extensions.
		Object.assign(newInstance, systemExtensions)

		await newInstance.init?.()

		// --- HMR Context Update ---
		// Let the performance monitor know about the new system.
		const perfMon = systemRegistry.getSystem('PerformanceMonitor')
		if (perfMon) {
			// On HMR, reset the system's performance history to get clean data.
			perfMon.resetSystem(systemName)
			perfMon.trackSystem(systemName)
		}

		// Re-calculate the context for the swapped system and broadcast it to workers.
		const systemId = this.getSystemId(systemName)
		const metadata = this.systemMetadataCache.get(systemId)
		if (metadata?.dependencies) {
			// Ensure the system entry exists in the main thread's cache
			if (!this.allSystemContexts[systemId]) {
				this.allSystemContexts[systemId] = {}
			}
			// Iterate over the system's kernels and update/broadcast their contexts.
			for (const kernelId of metadata.dependencies.keys()) {
				const newContext = this._getKernelContext(systemId, kernelId)
				// Update the local cache for the main thread's scheduler.
				this.allSystemContexts[systemId][kernelId] = newContext

				if (Object.keys(newContext).length > 0) {
					this.workerManager.broadcast('hmr-context-update', { systemId, kernelId, context: newContext })
				}
			}
		}

		// 5. Re-queue the new system instance into its correct update group.
		// The frequency is still stored in _systemConfig from the initial load.
		this.queSystem(newInstance)
		console.log(`[HMR] Successfully hot-swapped system: ${systemName}`)

		// Re-sort all groups to ensure the new system is in the correct canonical order.
		this._sortAllGroups()

		// --- HMR Synchronization: Resume the World ---
		this.gameLoop.resume()
	}

	/**
	 * Retrieves a system instance by its class name.
	 * This is a convenience method that delegates to the systemRegistry.
	 * @param {string} systemName - The class name of the system.
	 * @returns {object | undefined} The system instance, or undefined if not found.
	 */
	getSystem(systemName) {
		return systemRegistry.getSystem(systemName)
	}

	/**
	 * Retrieves the persistent integer ID for a given system name.
	 * @param {string} systemName - The class name of the system.
	 * @returns {number | undefined} The system's ID.
	 */
	getSystemId(systemName) {
		return this.systemNameToId.get(systemName)
	}

	/**
	 * Retrieves the system name for a given persistent integer ID.
	 * @param {number} systemId - The ID of the system.
	 * @returns {string | undefined} The system's class name.
	 */
	getSystemNameById(systemId) {
		return this.idToSystemName.get(systemId)
	}

	/**
	 * Retrieves a system instance by its persistent integer ID.
	 * @param {number} systemId - The ID of the system.
	 * @returns {object | undefined} The system instance.
	 */
	getSystemById(systemId) {
		const systemName = this.idToSystemName.get(systemId)
		return systemName ? systemRegistry.getSystem(systemName) : undefined
	}
	/**
	 * Builds the context for a specific system's kernel.
	 * This is a private helper used during the context caching phase.
	 * @param {number} systemId - The numeric ID of the system.
	 * @param {number} kernelId - The numeric ID of the kernel/method to get context for.
	 * @returns {object}
	 * @private
	 */
	_getKernelContext(systemId, kernelId) {
		const metadata = this.systemMetadataCache.get(systemId)
		const kernelDeps = metadata?.dependencies?.get(kernelId)
		if (!kernelDeps || !kernelDeps.context) {
			return {} // No context defined for this kernel
		}

		const finalContext = kernelDeps.context

		// For logging purposes only.
		const systemName = this.getSystemNameById(systemId)
		const kernelName = kernelRegistry.idToKernel.get(kernelId)?.name || kernelId

		// --- Validation for the new architecture ---
		// We are enforcing that the context must be a plain object.
		// The "Context Factory" pattern (a function) and legacy array pattern are deprecated.
		if (typeof finalContext !== 'object' || finalContext === null || Array.isArray(finalContext)) {
			console.error(
				`[SystemManager] FATAL: System "${systemName}" kernel "${kernelName}" has an invalid context definition. Context must be a plain object.`,
			)
			return {}
		}

		// Validate the final context object to ensure only serializable data is passed.
		for (const key in finalContext) {
			const value = finalContext[key]
			const valueType = typeof value
			if (valueType === 'function') {
				console.error(
					`[SystemManager] FATAL: System "${systemName}" kernel "${kernelName}" has a context property "${key}" of type "function". ` +
						`Functions cannot be passed in kernel contexts.`,
				)
			}
		}
		return finalContext
	}

	/**
	 * Gathers and caches the static context for all parallel systems.
	 * This is called once after all systems have been instantiated.
	 * @private
	 */
	_buildAndCacheSystemContexts() {
		const allContexts = {}
		// Iterate over system IDs, not names, for performance.
		for (const systemId of this.idToSystemName.keys()) {
			const system = this.getSystemById(systemId)
			if (!system) continue

			const metadata = this.systemMetadataCache.get(systemId)
			if (!metadata?.dependencies) continue

			const systemContexts = {}
			let hasAnyContext = false

			// Iterate over numeric kernel IDs.
			for (const kernelId of metadata.dependencies.keys()) {
				const context = this._getKernelContext(systemId, kernelId)
				if (Object.keys(context).length > 0) {
					systemContexts[kernelId] = context
					hasAnyContext = true
				}
			}

			if (hasAnyContext) {
				allContexts[systemId] = systemContexts
			}
		}
		this.allSystemContexts = allContexts
	}
	/**
	 * Records the execution time for a specific part of a system's logic.
	 * This is called by the Scheduler after a job completes.
	 * @param {number | string} systemIdOrName - The ID of the system, or name for pseudo-systems.
	 * @param {number|'total'} jobType - The type of job, from the JOB_TYPE enum or 'total'.
	 * @param {number} duration - The execution time in milliseconds.
	 */
	recordSystemTiming(systemIdOrName, jobType, duration) {
		const timings = this.systemTimings[systemIdOrName] || { update: 0, schedule: 0, process: 0, total: 0 }

		// If jobType is a number from the JOB_TYPE enum, record it in the specific phase.

		// JOB_TYPE.UPDATE = 0, .KERNEL = 1, .PROCESS = 2. KERNEL is used for schedule() timing.
		const JOB_TYPE_NAMES = { 0: 'update', 1: 'schedule', 2: 'process' }
		const jobTypeName = JOB_TYPE_NAMES[jobType]

		if (jobTypeName) {
			timings[jobTypeName] += duration
		}

		// All valid durations contribute to the system's total time for the frame.
		timings.total += duration
		this.systemTimings[systemIdOrName] = timings
	}

	/**
	 * Destroys the SystemManager and cleans up its resources.
	 */
	destroy() {
		// First, destroy all managed systems to allow them to clean up their resources.
		for (const systemInstance of systemRegistry.systemInstances.values()) {
			try {
				systemInstance.destroy?.()
			} catch (error) {
				console.error(`Error destroying system ${systemInstance.constructor.name}:`, error)
			}
		}
		// Then destroy the game loop.
		this.gameLoop.destroy()

		systemRegistry.clear()
		kernelRegistry.clear()
		this.updateGroups = {}
		this._systemConfig.clear()

		// Clean up the HMR event listener.
		eventEmitter.off(this.hmrListenerId, 'hmr:system-update')
	}
}

export const systemManager = new SystemManager()
