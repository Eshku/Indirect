/**
 * A kernel for the ContextTestSystem.
 * It reads a value from a shared buffer written by the `update` phase,
 * verifies it, and writes a new value for the `process` phase to read.
 * @param {number} payload - The chunkId to process.
 * @param {object} systemContext - Contains the shared state buffer.
 * @param {object} kernelContext - Unused for this kernel.
 */
export function contextTest(payload, systemContext, kernelContext) {
	// To prevent log spam from multiple chunks/jobs, we use a global flag.
	if (globalThis.hasRunScheduleTest) return
	globalThis.hasRunScheduleTest = true

	const { sharedState } = systemContext
	const { currentTick } = frameContext

	// --- 1. Verify value from `update` ---
	const valueToRead = 1
	const readValue = Atomics.load(sharedState, 0)

	if (readValue === valueToRead) {
		console.log(
			`%c[ContextTestSystem] schedule (tick ${currentTick}): Correctly read value -> ${readValue}`,
			'color: lightgreen',
		)
	} else {
		console.error(
			`[ContextTestSystem] schedule (tick ${currentTick}): FAILED! Expected to read ${valueToRead}, but got ${readValue}.`,
		)
	}

	// --- 2. Write new value for `process` ---
	const valueToWrite = 2
	Atomics.store(sharedState, 0, valueToWrite)
	console.log(`%c[ContextTestSystem] schedule (tick ${currentTick}): Wrote new value -> ${valueToWrite}`, 'color: cyan')
}