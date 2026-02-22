const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager, payloadCompiler } = ecs

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
	constructor() {
		// --- 1. Initialize Context Property ---
		// Create a SharedArrayBuffer that will be passed to workers via the context.
		// It holds a single Int32 value for our test.
		const sab = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
		this.sharedState = new Int32Array(sab)

		// --- 2. Setup for creating a test entity ---
		// The schedule method needs at least one chunk to operate on. We create a query
		// that will match the test entity we create in `init`.
		const { contextTestTag } = ecs.getTypeIDs()
		this.scheduleQuery = queryManager.getQuery({
			with: [contextTestTag],
		})

		// Pre-compile the payload for creating the test entity.
		const { payload } = payloadCompiler.compileEntity({
			contextTestTag: {},
		})
		this.creationPayload = payload
	}

	init() {
		// Create a single entity to ensure the schedule phase has a job to run.
		this.commands.createEntity(this.creationPayload)
		console.log('[ContextTestSystem] Initialized and created a test entity.')
	}

	update({ currentTick }) {
		// This runs on the main thread before `schedule`.
		const valueToWrite = 1
		Atomics.store(this.sharedState, 0, valueToWrite)
		console.log(`%c[ContextTestSystem] update (tick ${currentTick}): Wrote value -> ${valueToWrite}`, 'color: orange')
	}

	schedule(chunk, context) {
		// This runs on a worker thread. It will run once for our single test entity's chunk.
		// To prevent log spam from multiple chunks/jobs, we use a global flag.
		if (globalThis.hasRunScheduleTest) return
		globalThis.hasRunScheduleTest = true

		// --- 1. Verify value from `update` ---
		const valueToRead = 1
		const readValue = Atomics.load(context.sharedState, 0)

		if (readValue === valueToRead) {
			console.log(
				`%c[ContextTestSystem] schedule (tick ${context.currentTick}): Correctly read value -> ${readValue}`,
				'color: lightgreen',
			)
		} else {
			console.error(
				`[ContextTestSystem] schedule (tick ${context.currentTick}): FAILED! Expected to read ${valueToRead}, but got ${readValue}.`,
			)
		}

		// --- 2. Write new value for `process` ---
		const valueToWrite = 2
		Atomics.store(this.sharedState, 0, valueToWrite)
		console.log(
			`%c[ContextTestSystem] schedule (tick ${context.currentTick}): Wrote new value -> ${valueToWrite}`,
			'color: cyan',
		)
	}

	process({ currentTick }) {
		// This runs on the main thread after all `schedule` jobs are complete.
		const valueToRead = 2
		const readValue = Atomics.load(this.sharedState, 0)

		if (readValue === valueToRead) {
			console.log(
				`%c[ContextTestSystem] process (tick ${currentTick}): Correctly read value -> ${readValue}`,
				'color: lightblue',
			)
		} else {
			console.error(
				`[ContextTestSystem] process (tick ${currentTick}): FAILED! Expected to read ${valueToRead}, but got ${readValue}.`,
			)
		}

		// Reset the flag for the next frame's test run.
		globalThis.hasRunScheduleTest = false
	}

	destroy() {
		// Clean up the test entity on HMR.
		for (const chunk of this.scheduleQuery.iter()) {
			this.commands.destroyEntitiesInChunk(chunk)
		}
		console.log('[ContextTestSystem] Destroyed test entity.')
	}
}
