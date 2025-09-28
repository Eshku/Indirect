const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { workerManager } = engine.getManagers()

//! Not implemented.

export class ParallelismTestSystem {
	constructor() {
		// The test logic is now in init(), which runs only once.
	}

	async init() {
		console.log('[ParallelismTestSystem] Dispatching a test job to a worker...')

		try {
			const result = await workerManager.dispatchJob({
				type: 'ping',
				payload: { message: 'Hello from the main thread!' },
			})

			console.log(`[ParallelismTestSystem] Received response from worker:`, result)
		} catch (error) {
			console.error('[ParallelismTestSystem] Job dispatch failed:', error)
		}
	}

	update(deltaTime, currentTick) {}
}
