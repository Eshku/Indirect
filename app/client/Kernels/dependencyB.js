/**
 * Kernel for DependencySystemB. Reads, verifies, and writes a new value.
 * @param {number} payload - The chunkId to process.
 * @param {object} systemContext - Contains component TypeIDs.
 * @param {object} kernelContext - Contains thread-specific helpers.
 */
export function dependencyB(payload, systemContext, kernelContext) {
	const { velocity } = systemContext
	const { currentTick } = frameContext

	const chunk = kernel.getChunkView(payload)
	const velocities = chunk.componentData[velocity]

	// We only need to check the first entity in the chunk.
	const value = velocities.x[0]

	// This check will run in a worker thread.
	// It verifies that it's reading the value written by DependencySystemA.
	const expectedReadValue = 123
	if (value !== expectedReadValue) {
		console.error(
			`[DependencySystemB] FAILED! Expected to read ${expectedReadValue}, but got ${value}. 'A -> B' dependency might be broken.`,
		)
	} else {
		// To avoid spamming the console, only log success once.
		if (!globalThis.dependencyTestB_Passed) {
			console.log(`%c[DependencySystemB] SUCCESS! Read value ${value} from A. 'A -> B' is working.`, 'color: cyan')
			globalThis.dependencyTestB_Passed = true
		}
	}

	// Now, write a new value for DependencySystemC to read.
	velocities.x[0] = 456
	chunk.markDirty(velocity, currentTick)
}