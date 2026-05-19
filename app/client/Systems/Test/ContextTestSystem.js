const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const { contextTest } = ecs.getKernelIDs()

const { contextTestTag } = ecs.getComponentIDs()

// --- Define shared resources in the module scope ---
const sharedState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

/**
 * A system to test that properties passed via the `schedule` context are correctly
 * shared between the main thread and worker threads, with a focus on SharedArrayBuffer.
 *
 * It follows a simple data flow:
 * 1. `update` (Main Thread): Writes an initial value (1) to a SharedArrayBuffer.
 * 2. `schedule` (Worker Thread): Reads the value, verifies it's 1, and writes a new value (2).
 * 3. `process` (Main Thread): Reads the value again and verifies it's 2.
 */
export class ContextTestSystem {
	static dependencies = {
		contextTest: {
			// Pass the module-scoped buffer into the context for the kernel.
			context: {
				sharedState: sharedState,
			},
		},
	}

	init() {
		// Main thread methods now access the buffer directly.
		this.sharedState = sharedState

		this.query = this.getQuery({
			with: [contextTestTag],
		})

		this.creationPayload = this.compile({
			contextTestTag: {},
		})

		// Create a single entity to ensure the schedule phase has a job to run.
		this.instantiate(this.creationPayload, 1)
		console.log('[ContextTestSystem] Initialized and created a test entity.')
	}

	update({ currentVersion }) {
		// This runs on the main thread before `schedule`.
		const valueToWrite = 1
		Atomics.store(this.sharedState, 0, valueToWrite)
		console.log(`%c[ContextTestSystem] update (version ${currentVersion}): Wrote value -> ${valueToWrite}`, 'color: orange')
	}

	/**
	 * Schedules a kernel job for each chunk to test context passing.
	 * @param {import('../../Managers/SystemManager/JobWriter.js').JobWriter} jobWriter
	 */
	schedule(jobWriter) {
		jobWriter.scheduleForEachChunk(this.query, contextTest)
	}

	process({ currentVersion }) {
		// This runs on the main thread after all `schedule` jobs are complete.
		const valueToRead = 2
		const readValue = Atomics.load(this.sharedState, 0)

		if (readValue === valueToRead) {
			console.log(
				`%c[ContextTestSystem] process (version ${currentVersion}): Correctly read value -> ${readValue}`,
				'color: lightblue',
			)
		} else {
			console.error(`[ContextTestSystem] process (version ${currentVersion}): FAILED! Expected to read ${valueToRead}, but got ${readValue}.`)
		}

		// Reset the flag for the next frame's test run.
		globalThis.hasRunScheduleTest = false
	}

	destroy() {
		// Clean up the test entity on HMR.
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			this.destroyEntitiesInChunk(chunkIds[i])
		}
		console.log('[ContextTestSystem] Destroyed test entity.')
	}
}
