const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { customJob } = ecs.getKernelIDs()

const testConfig = {
	logVerbose: false, // Set to true for detailed step-by-step logs
}

/**
 * A system to demonstrate and test:
 * 1. Custom Jobs: Creating a kernel job where the payload is not a chunkId.
 * 2. Dynamic Requests: Using a SharedArrayBuffer to pass data from the main-thread
 *    `update` phase to a parallel `kernel` job.
 */
export class CustomJobTestSystem {
	static dependencies = {
		update: {},
		customJob: {
			// This kernel needs access to the buffers via its context.
			context: {
				requestBuffer: new Int32Array(new SharedArrayBuffer(4)),
				resultBuffer: new Int32Array(new SharedArrayBuffer(4)),
				logVerbose: testConfig.logVerbose,
			},
		},
		process: {},
	}

	constructor() {
		// We can get a direct reference to the context object defined statically.
		const context = CustomJobTestSystem.dependencies.customJob.context
		this.requestBuffer = context.requestBuffer
		this.resultBuffer = context.resultBuffer

		console.log('[CustomJobTestSystem] Initialized.')
	}

	/**
	 * Runs on the main thread. We will write a "dynamic request" to the shared buffer.
	 */
	update({ currentTick }) {
		// Every 60 ticks, post a new request.
		if (currentTick > 0 && currentTick % 60 === 0) {
			const value = Math.floor(Math.random() * 100) + 1
			if (testConfig.logVerbose) {
				console.log(`%c[CustomJobTestSystem] update: Posting dynamic request -> ${value}`, 'color: orange')
			}
			Atomics.store(this.requestBuffer, 0, value)
		}
	}

	/**
	 * Runs on the main thread to create jobs.
	 */
	schedule() {
		// Create a single "listener" kernel job.
		// The payload is a custom value, not a chunkId.
		const jobs = [
			{
				kernel: customJob,
				payload: 42, // Our custom payload
			},
		]
		return jobs
	}

	/**
	 * Runs on the main thread after kernels are complete. We'll check for a result.
	 */
	process({ currentTick }) {
		// Reset the worker's log flag periodically if verbose logging is on.
		if (testConfig.logVerbose && currentTick > 0 && currentTick % 60 === 0) {
			self.hasRunCustomJobTest = false
		}

		const result = Atomics.load(this.resultBuffer, 0)
		if (result !== 0) {
			// A result has arrived. Verify it's valid.
			const originalRequest = result / 10

			if (result % 10 === 0) {
				console.log(
					`%c[CustomJobTestSystem] SUCCESS: Kernel processed a dynamic request. (Result: ${result}, Inferred Request: ${originalRequest})`,
					'color: lightgreen',
				)
			} else {
				console.error(`[CustomJobTestSystem] FAILED: Received an invalid result from kernel: ${result}.`)
			}

			if (testConfig.logVerbose) {
				console.log(`%c[CustomJobTestSystem] process: Received result from kernel -> ${result}`, 'color: lightblue')
			}
			// Clear the result after reading it.
			Atomics.store(this.resultBuffer, 0, 0)
		}
	}
}