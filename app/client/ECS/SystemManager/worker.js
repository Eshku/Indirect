/**
 * This is the entry point for our Web Workers.
 * It instantiates the main worker logic class and sets up the message listener.
 */

class WorkerEntry {
	constructor() {
		self.onmessage = this.handleMessage.bind(this)
	}

	handleMessage(event) {
		const { type, jobId, ...payload } = event.data

		try {
			if (type === 'ping') {
				// Simple test job
				console.log(`[Worker] Received ping job ${jobId} with payload:`, payload)
				self.postMessage({
					type: 'job_complete',
					jobId: jobId,
					result: 'pong',
				})
			} else {
				throw new Error(`Unknown job type: ${type}`)
			}
		} catch (e) {
			self.postMessage({
				type: 'job_error',
				jobId: jobId,
				error: e.message,
			})
		}
	}
}

// Instantiate the worker logic and signal readiness to the main thread.
new WorkerEntry()
self.postMessage({ type: 'ready' })
