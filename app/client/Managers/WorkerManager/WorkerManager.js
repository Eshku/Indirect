import { eventEmitter } from '../../Core/Classes/EventEmitter.js'
import { entityStore } from '../../ECS/EntityManager/EntityManager.js'

/**
 * Manages a pool of Web Workers for parallel job execution.
 * This manager is responsible for creating workers, dispatching jobs,
 * and handling communication between the main thread and worker threads.
 */
export class WorkerManager {
	constructor() {
		/** @type {Worker[]} */
		this.workers = []

		this.workerCount = 0
		this.totalThreads = 1

		/** @type {Function | null} */
		this.importFromString = null

		// This will be populated by HMR or a production build script.
		this.logicRegistry = {}
		this.sharedBuffers = {}

		this.systemContextCache = new Map()

		this.hmrListenerId = null
	}

	async init() {
		const hardwareConcurrency = navigator.hardwareConcurrency || 4

		// Add a reference to the job graph's shared state.
		// Leave one core for the main thread, renderer, etc.
		this.workerCount = Math.max(1, hardwareConcurrency - 1)
		this.totalThreads = this.workerCount + 1

		const { createURLFromString } = await import(`${PATH_CORE}/utils/blob.js`)
		// This is a dynamic import that will only be resolved in a dev environment
		this.importFromString = (await import(`${PATH_CORE}/utils/blob.js`)).importFromString

		const workerURL = new URL(`./worker.js`, import.meta.url)

		const response = await fetch(workerURL)
		const workerCode = await response.text()
		const objectURL = createURLFromString(workerCode, { name: 'ECS-Worker' })

		// Loop from 1 to workerCount to align the worker's name with its ID.
		// The main thread is conceptually worker 0.
		for (let i = 1; i <= this.workerCount; i++) {
			const worker = new Worker(objectURL, {
				type: 'module',
				name: `ECS-Worker-${i}`, // e.g., ECS-Worker-1, ECS-Worker-2
			})
			worker.id = i
			this.workers.push(worker)
		}

		// Clean up the object URL once all workers are created.
		URL.revokeObjectURL(objectURL)

		// Subscribe to HMR events for schedule logic.
		this.hmrListenerId = eventEmitter.on('hmr:schedule-update', data => this.hotSwapScheduleLogic(data))
	}

	/**
	 * The second stage of initialization. This is called by the GameLoop after the
	 * Scheduler has created the SharedArrayBuffers. This method sends all necessary
	 * shared data to the workers and waits for them to be ready.
	 * @param {import('../../ECS/EntityManager/ECS.js').ECS} ecs
	 */
	async initializeWorkers(ecs) {
		this.ecs = ecs
		this.entityManager = ecs.entityManager
		const { physicsManager } = ecs.engine.getManagers()

		// Get the shared buffers from the scheduler.
		const scheduler = ecs.systemManager.gameLoop.scheduler
		this.sharedBuffers = scheduler.getSharedBuffers()

		const sharedData = this.entityManager.getSharedData()

		const workerPromises = []

		const systemIdMap = {}
		for (const [name, id] of this.ecs.systemManager.systemNameToId.entries()) {
			systemIdMap[name] = id
		}

		const prebuiltLogics = await this.loadPrebuiltLogic();
        const initialChunks = {};
        for (let i = 0; i < this.entityManager.nextChunkId; i++) {
            initialChunks[i] = {
                data: this.entityManager.getSharedComponentData(i),
                ticks: this.entityManager.getSharedDirtyTicks(i),
                archetypeTicks: entityStore.chunkArchetypeDirtyTicks[i],
            };
        }

		// Now, send the full init payload to each worker and wait for them to be ready.
		for (const worker of this.workers) {
			const readyPromise = new Promise((resolve, reject) => {
				const handleWorkerMessage = event => {
					const { type, error } = event.data

					if (type === 'ready') {
						resolve(worker)
					} else if (type === 'job_error') {
						// Errors are still useful for debugging.
						console.error(`[WorkerManager] Received error from Worker ${worker.id}:`, error)
					}
				}

				// Assign the unique handler to this specific worker.
				worker.onmessage = handleWorkerMessage

				worker.onerror = errorEvent => {
					// Prevent the default browser error handling (e.g., logging to console).
					errorEvent.preventDefault()
					// The `error` property often contains the actual Error object, which is more reliable.
					const error = errorEvent.error
					const message = error ? error.stack || error.message : errorEvent.message
					const errorMessage = `Uncaught error in Worker ${worker.id}: ${message}`
					console.error(`[WorkerManager] ${errorMessage}`)
					reject(new Error(errorMessage))
				}
			})

			// Send the initialization payload to the worker.
			worker.postMessage(
				{
					type: 'init',
					baseUrl: import.meta.url,
					workerId: worker.id,
					sharedData,
					// Send the main SABs
					frameStateSAB: this.sharedBuffers.frameStateSAB,
					jobsSAB: this.sharedBuffers.jobsSAB,
					dependentsSAB: this.sharedBuffers.dependentsSAB,
					frameContextSAB: this.sharedBuffers.frameContextSAB,
					// Send the MPSC inbox for workers to send MTO jobs to the main thread
					mainThreadInbox: this.sharedBuffers.mainThreadInbox,
					dequeBuffers: this.sharedBuffers.dequeBuffers, // Send the array of deque buffers
					systemIdMap,
					spatialHashGridSABs: physicsManager.getSpatialHashGridSABs(),
					totalThreads: this.totalThreads,
					initialChunks,
					prebuiltLogics
				}
			)
			workerPromises.push(readyPromise)
		}

		await Promise.all(workerPromises)

		// After all logic is loaded, convert the code strings to actual functions for the main thread.
		for (const systemName in this.logicRegistry) {
			const entry = this.logicRegistry[systemName]
			if (entry.code && !entry.logic) entry.logic = (await this.importFromString(entry.code)).schedule
		}
	}

	/**
	 * Gathers and broadcasts the initial static context for all parallel systems.
	 * This is called once after all systems have been instantiated.
	 */
	broadcastInitialSystemContexts() {
		const allSystemContexts = {}
		for (const systemName of this.ecs.systemManager.systemNameToId.keys()) {
			const system = this.ecs.systemManager.getSystem(systemName)
			if (system) {
				const metadata = this.ecs.systemManager.systemMetadataCache.get(systemName)
				if (metadata?.hasSchedule) {
					allSystemContexts[systemName] = this.getSystemContext(systemName, system)
				}
			}
		}

		this.workers.forEach(worker => {
			worker.postMessage({
				type: 'init-contexts',
				systemContexts: allSystemContexts,
			})
		})
	}

	/**
	 * Broadcasts newly created chunk data to all workers.
	 * @param {object} chunkDeltas - The delta payload from EntityManager.
	 */
	broadcastChunkDeltas(chunkDeltas) {
		this.workers.forEach(worker => {
			worker.postMessage({
				type: 'sync-chunk-deltas',
				...chunkDeltas,
			})
		})
	}

	/**
	 * Loads the pre-built logic manifest from the /dist folder.
	 * This is used for initial startup in both development and production.
	 */
	async loadPrebuiltLogic() {
		const logics = {}

		const { logicRegistry: prebuiltRegistry } = await import('../../../../dist/systems/parallelSystemLogics.js')

		if (!prebuiltRegistry) return logics

		for (const systemName in prebuiltRegistry) {
			const { logic, dependencies } = prebuiltRegistry[systemName]

			this.logicRegistry[systemName] = {
				dependencies,
				code: `export const schedule = ${logic.toString()};`,
				logic: null,
			}
			logics[systemName] = {
				dependencies,
				code: `export const schedule = ${logic.toString()};`,
			}
		}

		return logics
	}

	/**
	 * Retrieves the actual schedule function for a system.
	 * @param {string} systemName
	 * @returns {Function | undefined}
	 */
	getSystemLogic(systemName) {
		return this.logicRegistry[systemName]?.logic
	}

	/**
	 * Builds the context for a specific system's schedule function.
	 * This is used by the Scheduler on the main thread to execute schedule jobs.
	 * @param {string} systemName
	 * @param {object} system - The actual system instance. *
	 * @returns {object}
	 */
	getSystemContext(systemName, system) {
		const logicEntry = this.logicRegistry[systemName]

		// Get or create the cached context object for this system to prevent per-frame allocations.
		let scheduleContext = this.systemContextCache.get(systemName)
		if (!scheduleContext) {
			scheduleContext = {}
			this.systemContextCache.set(systemName, scheduleContext)
		}

		// Clear any old properties from the reused object to handle HMR correctly.
		for (const key in scheduleContext) {
			delete scheduleContext[key]
		}

		if (system && logicEntry?.dependencies) {
			for (const dep of logicEntry.dependencies) {
				const value = system[dep]
				const valueType = typeof value
				if (value !== undefined) {
					const isPrimitive =
						valueType === 'number' || valueType === 'string' || valueType === 'boolean' || valueType === 'bigint'
					const isSharedArrayBuffer = value instanceof SharedArrayBuffer;
                    // Check if it's a TypedArray (like Int32Array) that is a view on a SharedArrayBuffer.
                    const isTypedArrayOnSAB = value?.buffer instanceof SharedArrayBuffer;

					// Allow only primitives or SharedArrayBuffers to be passed as context.
					// Other objects would be copied, leading to performance issues and memory leaks.
					if (!isPrimitive && !isSharedArrayBuffer && !isTypedArrayOnSAB) {
						console.error(
							`[WorkerManager] FATAL: System "${systemName}" has a non-primitive dependency "${dep}" of type "${valueType}". ` +
								`Only primitives, SharedArrayBuffer, and TypedArrays on a SharedArrayBuffer are allowed in the schedule context.`
						)
					}
				}
				scheduleContext[dep] = value
			}
		}
		return scheduleContext
	}

	/**
	 * Broadcasts new transpiled `schedule` logic to all workers for hot-swapping.
	 * @param {object} hmrData - The HMR payload from the client-watcher.
	 */
	async hotSwapScheduleLogic(hmrData) {
		const { systemName, dependencies, code } = hmrData;

		// 1. Update the main thread's registry.
		if (this.logicRegistry[systemName]) {
			// Update the logic for the main thread to use.
			const newModule = await this.importFromString(code)
			this.logicRegistry[systemName].logic = newModule.schedule
			this.logicRegistry[systemName].dependencies = dependencies
		} else {
			// This can happen if a system with a schedule() method is added for the first time via HMR.
			const newModule = await this.importFromString(code);
            this.logicRegistry[systemName] = {
                dependencies,
                code: `export const schedule = ${newModule.schedule.toString()};`,
                logic: newModule.schedule,
            };
		}

		// 2. Broadcast the new code to all workers.
		this.broadcastLogicToWorkers({ systemName, dependencies, code })
	}

	/**
	 * Gathers the new context from a hot-swapped system instance and broadcasts it to all workers.
	 * @param {string} systemName The name of the system that was swapped.
	 * @param {object} systemInstance The new instance of the system.
	 */
	hotSwapSystemContext(systemName, systemInstance) {
		const metadata = this.ecs.systemManager.systemMetadataCache.get(systemName)
		if (metadata?.hasSchedule) {
			const newContext = this.getSystemContext(systemName, systemInstance)
			this.workers.forEach(worker => {
				worker.postMessage({
					type: 'hmr-context-update',
					systemName,
					context: newContext,
				})
			})
		}
	}

	/**
	 * Sends schedule logic code to all workers.
	 * @param {{systemName: string, dependencies: string[], code: string}} logicData
	 * @private
	 */
	broadcastLogicToWorkers(logicData) {
		this.workers.forEach(worker => {
			worker.postMessage({
				type: 'hmr-schedule-update',
				...logicData,
			})
		})
	}

	destroy() {
		for (const worker of this.workers) {
			worker.terminate()
		}
		this.workers = []
		eventEmitter.off(this.hmrListenerId)
	}
}

export const workerManager = new WorkerManager()
