/**
 * Manages a pool of Web Workers for parallel job execution.
 * This manager is responsible for creating workers, dispatching jobs,
 * and handling communication between the main thread and worker threads.
 */
export class WorkerManager {
	constructor() {
		/** @type {Worker[]} */
		this.workers = []
		/** @type {Worker[]} */
		this.idleWorkers = []
		this.nextJobId = 0

		/** @type {Map<number, { resolve: Function, reject: Function }>} */
		this.activeJobs = new Map()
	}

	async init() {
		const hardwareConcurrency = navigator.hardwareConcurrency || 4
		// Leave one core for the main thread, renderer, etc.
		const workerCount = Math.max(1, hardwareConcurrency - 1)

		const workerURL = new URL(`${PATH_ECS}/SystemManager/worker.js`, import.meta.url)

		//! little hack to allow creating workers on client side
		//! electron restrictions stuffs
		const response = await fetch(workerURL)
		const workerCode = await response.text()

		const blob = new Blob([workerCode], { type: 'application/javascript' })
		const objectURL = URL.createObjectURL(blob)

		const workerPromises = []

		for (let i = 0; i < workerCount; i++) {
			const worker = new Worker(objectURL, {
				type: 'module',
				name: `ECS-Worker-${i}`,
			})

			worker.id = i

			const readyPromise = new Promise((resolve, reject) => {
				worker.onmessage = event => {
					const { type, jobId, error, result } = event.data

					if (type === 'ready') {
						//console.log(`[WorkerManager] Worker ${worker.id} is ready.`)
						this.idleWorkers.push(worker)
						resolve(worker)
					} else if (type === 'job_complete') {
						const jobPromise = this.activeJobs.get(jobId)
						if (jobPromise) {
							jobPromise.resolve(result)
							this.activeJobs.delete(jobId)
							this.idleWorkers.push(worker) // Worker is now idle
						}
					} else if (type === 'job_error') {
						const jobPromise = this.activeJobs.get(jobId)
						if (jobPromise) {
							jobPromise.reject(new Error(error))
							this.activeJobs.delete(jobId)
							this.idleWorkers.push(worker) // Worker is now idle
						}
					}
				}

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

			this.workers.push(worker)
			workerPromises.push(readyPromise)
		}

		await Promise.all(workerPromises)

		// Clean up the object URL once all workers are created.
		URL.revokeObjectURL(objectURL)
	}

	/**
	 * Dispatches a job to the next available worker.
	 * For now, this is a simple round-robin. Later, this will be a work-stealing scheduler.
	 * @param {object} jobPayload - The data to send to the worker.
	 * @returns {Promise<any>} A promise that resolves with the result of the job.
	 */
	dispatchJob(jobPayload) {
		return new Promise((resolve, reject) => {
			if (this.idleWorkers.length === 0) {
				// For now, we'll just reject. A real scheduler would queue the job.
				return reject(new Error('No idle workers available.'))
			}

			const worker = this.idleWorkers.pop() // Take an idle worker
			const jobId = this.nextJobId++

			this.activeJobs.set(jobId, { resolve, reject })

			worker.postMessage({ ...jobPayload, jobId })
		})
	}

	destroy() {
		console.log('[WorkerManager] Terminating all workers.')
		for (const worker of this.workers) {
			worker.terminate()
		}
		this.workers = []
		this.idleWorkers = []
	}
}

export const workerManager = new WorkerManager()
