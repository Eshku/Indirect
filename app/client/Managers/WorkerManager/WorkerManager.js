import { eventEmitter } from '../../Core/Classes/EventEmitter.js'
import { entityStore } from '../../ECS/EntityManager/EntityManager.js'
import { kernelRegistry } from '../../ECS/SystemManager/KernelRegistry.js'

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

		const kernelCode = kernelRegistry.getAllKernelCode()
		const kernelMetadata = kernelRegistry.getKernelMetadata()

		const initialChunks = {}
		for (let i = 0; i < this.entityManager.nextChunkId; i++) {
			initialChunks[i] = {
				data: this.entityManager.getSharedComponentData(i),
				ticks: this.entityManager.getSharedDirtyTicks(i),
				archetypeTicks: entityStore.chunkArchetypeDirtyTicks[i],
			}
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
			worker.postMessage({
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
				kernelCode,
				kernelMetadata,
			})
			workerPromises.push(readyPromise)
		}

		await Promise.all(workerPromises)
	}

	/**
	 * Gathers and broadcasts the initial static context for all parallel systems.
	 * This is called once after all systems have been instantiated.
	 */
	broadcastInitialSystemContexts() {
		const allContexts = {}
		for (const systemName of this.ecs.systemManager.systemNameToId.keys()) {
			const system = this.ecs.systemManager.getSystem(systemName)
			if (!system) continue

			const metadata = this.ecs.systemManager.systemMetadataCache.get(systemName)
			if (!metadata?.dependencies) continue

			const systemContexts = {}
			let hasAnyContext = false

			// Iterate over all declared dependencies (methods and kernels)
			for (const kernelName in metadata.dependencies) {
				const context = this.getSystemContext(system, kernelName)
				if (Object.keys(context).length > 0) {
					systemContexts[kernelName] = context
					hasAnyContext = true
				}
			}

			if (hasAnyContext) {
				allContexts[systemName] = systemContexts
			}
		}
		this.workers.forEach(worker => {
			worker.postMessage({
				type: 'init-contexts',
				systemContexts: allContexts,
			})
		})
	}

	/**
	 * Broadcasts newly created chunk data to all workers.
	 * @param {object} chunkDeltas - The delta payload from EntityManager.
	 */
	broadcastDeltas() {
		const chunkDeltas = this.entityManager.getAndClearChunkDeltas()
		const archetypePageDeltas = this.entityManager.getAndClearArchetypePageDeltas()

		if (chunkDeltas.newChunks || chunkDeltas.destroyedChunks) {
			this.workers.forEach(worker => {
				worker.postMessage({
					type: 'sync-chunk-deltas',
					...chunkDeltas,
				})
			})
		}

		if (archetypePageDeltas) {
			this.workers.forEach(worker => {
				worker.postMessage({ type: 'sync-archetype-store-pages', pages: archetypePageDeltas })
			})
		}
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
	 * This is used to gather static data to be sent to workers.
	 * @param {object} system - The actual system instance.
	 * @param {string} kernelName - The name of the kernel/method to get context for.
	 * @returns {object}
	 */
	getSystemContext(system, kernelName) {
		const systemName = system.constructor.name
		const metadata = this.ecs.systemManager.systemMetadataCache.get(systemName)
		const kernelDeps = metadata?.dependencies?.[kernelName]

		if (!kernelDeps || !kernelDeps.context) {
			return {} // No context defined for this kernel
		}

		const finalContext = kernelDeps.context

		// --- Validation for the new architecture ---
		// We are enforcing that the context must be a plain object.
		// The "Context Factory" pattern (a function) and legacy array pattern are deprecated.
		if (typeof finalContext !== 'object' || finalContext === null || Array.isArray(finalContext)) {
			console.error(
				`[WorkerManager] FATAL: System "${systemName}" kernel "${kernelName}" has an invalid context definition. Context must be a plain object.`,
			)
			return {}
		}

		// Validate the final context object to ensure only serializable data is passed.
		for (const key in finalContext) {
			const value = finalContext[key]
			const valueType = typeof value

			if (valueType === 'function') {
				console.error(
					`[WorkerManager] FATAL: System "${systemName}" kernel "${kernelName}" has a context property "${key}" of type "function". ` +
						`Functions cannot be passed in kernel contexts.`,
				)
			}
			// We now allow plain objects. The structured clone algorithm used by postMessage
			// will handle them. It will throw its own error for non-serializable types (e.g. DOM elements).
		}
		return finalContext
	}

	/**
	 * Broadcasts new transpiled `schedule` logic to all workers for hot-swapping.
	 * @param {object} hmrData - The HMR payload from the client-watcher.
	 */
	async hotSwapScheduleLogic(hmrData) {
		// This method is now obsolete with the new kernel architecture.
		// HMR will be handled by swapping the kernel module itself.
		// The logic for this will be part of a future HMR implementation for kernels.
		console.warn(
			'[WorkerManager] hotSwapScheduleLogic is deprecated and will be removed. Kernel HMR is not yet implemented.',
		)
	}
	/**
	 * Gathers the new context from a hot-swapped system instance and broadcasts it to all workers.
	 * @param {string} systemName The name of the system that was swapped.
	 * @param {object} systemInstance The new instance of the system.
	 */
	hotSwapSystemContext(systemName, systemInstance) {
		const metadata = this.ecs.systemManager.systemMetadataCache.get(systemName)
		if (!metadata?.dependencies) return

		for (const kernelName in metadata.dependencies) {
			const newContext = this.getSystemContext(systemInstance, kernelName)
			if (Object.keys(newContext).length > 0) {
				this.workers.forEach(worker => {
					worker.postMessage({
						type: 'hmr-context-update',
						systemName,
						kernelName, // Let the worker know which kernel's context to update
						context: newContext,
					})
				})
			}
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
