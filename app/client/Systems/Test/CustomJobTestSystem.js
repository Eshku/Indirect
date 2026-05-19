const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const { customJob } = ecs.getKernelIDs()

const testConfig = {
	logVerbose: false, // Set to true for detailed step-by-step logs
}

// --- Define shared resources in the module scope for clarity ---
const requestBuffer = new Int32Array(new SharedArrayBuffer(4))
const resultBuffer = new Int32Array(new SharedArrayBuffer(4))

/**
 * A system to demonstrate and test:
 * 1. Custom Jobs: Creating a kernel job where the payload is not a chunkId.
 * 2. Dynamic Requests: Using a SharedArrayBuffer to pass data from the main-thread
 *    `update` phase to a parallel `kernel` job.
 */
export class CustomJobTestSystem {
	static dependencies = {
		customJob: {
			// This kernel needs access to the buffers via its context.
			context: {
				requestBuffer: requestBuffer,
				resultBuffer: resultBuffer,
				logVerbose: testConfig.logVerbose,
			},
		},
	}

	init() {
		// Main thread methods can now access the buffers directly from the module scope.
		this.requestBuffer = requestBuffer
		this.resultBuffer = resultBuffer
	}

	/**
	 * Runs on the main thread. We will write a "dynamic request" to the shared buffer.
	 */
	update({ currentVersion }) {
		// Every 60 ticks, post a new request.
		if (currentVersion > 0 && currentVersion % 60 === 0) {
			const value = Math.floor(Math.random() * 100) + 1
			if (testConfig.logVerbose) {
				console.log(`%c[CustomJobTestSystem] update: Posting dynamic request -> ${value}`, 'color: orange')
			}
			// Access via `this` property set in init().
			Atomics.store(this.requestBuffer, 0, value)
		}
	}

	/**
	 * Runs on the main thread to create jobs.
	 * @param {import('../../Managers/SystemManager/JobWriter.js').JobWriter} jobWriter
	 */
	schedule(jobWriter) {
		// Create a single "listener" kernel job with a custom payload.
		jobWriter.scheduleCustom(customJob, 42) // Our custom payload
	}

	/**
	 * Runs on the main thread after kernels are complete. We'll check for a result.
	 */
	process({ currentVersion }) {
		// Reset the worker's log flag periodically if verbose logging is on.
		if (testConfig.logVerbose && currentVersion > 0 && currentVersion % 60 === 0) {
			self.hasRunCustomJobTest = false
		}

		// Access via `this` property set in init().
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
