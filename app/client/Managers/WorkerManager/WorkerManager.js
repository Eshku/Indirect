const { eventEmitter } = await import(`@core/Classes/EventEmitter.js`)
const { kernelRegistry } = await import(`@managers/SystemManager/KernelRegistry.js`)

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

		/** @private */
		this._initialPayload = {}

		/** @type {Function | null} */
		this.importFromString = null

		this.logicRegistry = {}
		this.sharedBuffers = {}

		this.hmrListenerId = null
	}

	/**
	 * Queues a resource to be included in the initial payload sent to workers.
	 * This replaces the SharedResourceRegistry.
	 * @param {string} name The key for the resource in the payload.
	 * @param {any} resource The resource to send.
	 */
	addInitialResource(name, resource) {
		if (this._initialPayload.hasOwnProperty(name)) {
			console.warn(`[WorkerManager] Initial resource with name "${name}" already registered. Overwriting.`)
		}
		this._initialPayload[name] = resource
	}

	/**
	 * Broadcasts a message of a specific type to all workers.
	 * This is the universal channel for all runtime updates.
	 * @param {string} type A string identifier for the message (e.g., 'sync-deltas', 'hmr-update').
	 * @param {object} [payload={}] The data associated with the message.
	 * @param {Transferable[]} [transferList] Optional array of transferable objects. If not provided, they will be auto-detected.
	 */
	broadcast(type, payload = {}, transferList) {
		const message = { type, ...payload }
		// By default, postMessage will use the structured clone algorithm.
		// SharedArrayBuffers are handled correctly (shared by reference).
		// Regular ArrayBuffers are cloned (copied), which is the safe default.
		// If a developer needs to transfer ownership for performance, they must
		// explicitly provide the `transferList`. 
		this.workers.forEach(worker => {
			worker.postMessage(message, transferList)
		})
	}

	async init() {
		const hardwareConcurrency = navigator.hardwareConcurrency || 4

		// Leave one core for the main thread, renderer, etc.
		this.workerCount = Math.max(1, hardwareConcurrency - 1)
		this.totalThreads = this.workerCount + 1 // Main thread + workers

		this.addInitialResource('totalThreads', this.totalThreads)

		const { createURLFromString } = await import(`@core/utils/blob.js`)
		this.importFromString = (await import(`@core/utils/blob.js`)).importFromString

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
	 * @param {import('../../client/Engine.js').Engine} engine
	 */
	async initializeWorkers(engine) {
		this.entityManager = engine.getManagers().entityManager
		this.systemManager = engine.getManagers().systemManager

		const workerPromises = []

		// The init payload is now built internally from registered resources.
		const initMessage = {
			type: 'init',
			...this._initialPayload,
		}

		// Now, send the full init payload to each worker and wait for them to be ready.
		for (const worker of this.workers) {
			const finalPayload = { ...initMessage, workerId: worker.id, baseUrl: import.meta.url }
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
			// No transfer list is needed. SharedArrayBuffers are automatically shared by reference.
			// Any other data (including regular ArrayBuffers) is safely cloned.
			worker.postMessage(finalPayload)
			workerPromises.push(readyPromise)
		}

		await Promise.all(workerPromises)

		// The initial payload is no longer needed and can be cleared to free memory
		// and prevent accidental re-use.
		this._initialPayload = null
	}

	/**
	 * Gathers and broadcasts the initial static context for all parallel systems.
	 * This is called once after all systems have been instantiated.
	 */
	broadcastInitialSystemContexts() {
		// Get the pre-compiled context object from the SystemManager, which is the source of truth.
		const allContexts = this.systemManager.getSystemContexts()
		this.broadcast('init-contexts', { systemContexts: allContexts })
	}

	/**
	 * Broadcasts newly created chunk data to all workers.
	 * @param {object} chunkDeltas - The delta payload from EntityManager.
	 */
	broadcastDeltas() {
		const chunkDeltas = this.entityManager.getAndClearChunkDeltas()
		const archetypePageDeltas = this.entityManager.getAndClearArchetypePageDeltas()

		if (chunkDeltas.newChunks || chunkDeltas.destroyedChunks) {
			this.broadcast('sync-chunk-deltas', chunkDeltas)
		}

		if (archetypePageDeltas) {
			this.broadcast('sync-archetype-store-pages', { pages: archetypePageDeltas })
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

	destroy() {
		for (const worker of this.workers) {
			worker.terminate()
		}
		this.workers.length = 0

		eventEmitter.off(this.hmrListenerId)
	}
}

export const workerManager = new WorkerManager()
