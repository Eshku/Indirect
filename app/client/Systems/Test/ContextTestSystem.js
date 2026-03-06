const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { contextTest } = ecs.getKernelIDs()

const { contextTestTag } = ecs.getTypeIDs()

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
		update: {},
		contextTest: {
			context: {
				sharedState: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
			},
		},
		process: {},
	}

	constructor() {
		this.sharedState = ContextTestSystem.dependencies.contextTest.context.sharedState
	}

	init() {
		this.query = this.getQuery({
			with: [contextTestTag],
		})

		const { payload } = this.compiler.compileEntity({
			contextTestTag: {},
		})
		this.creationPayload = payload

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

	schedule() {
		const jobs = []
		const chunkIds = this.query.getChunks()

		for (const chunkId of chunkIds) {
			jobs.push({
				kernel: contextTest,
				payload: chunkId,
			})
		}
		return jobs
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
		for (const chunk of this.query.iter()) {
			this.commands.destroyEntitiesInChunk(chunk)
		}
		console.log('[ContextTestSystem] Destroyed test entity.')
	}
}
