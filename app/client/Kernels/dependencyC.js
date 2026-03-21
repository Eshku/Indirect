/**
 * Kernel for DependencySystemC. Reads and verifies a value.
 * @param {number} payload - The chunkId to process.
 * @param {object} systemContext - Contains component TypeIDs.
 * @param {object} kernelContext - Contains thread-specific helpers.
 */
export function dependencyC(payload, systemContext, kernelContext) {
	const { velocity } = systemContext

	const chunk = parallel.getChunkView(payload)
	const velocities = chunk.componentData[velocity]
	const value = velocities.x[0]

	const expectedReadValue = 456
	if (value !== expectedReadValue) {
		console.error(
			`[DependencySystemC] FAILED! Expected to read ${expectedReadValue}, but got ${value}. 'B -> C' dependency might be broken.`,
		)
	} else {
		if (!globalThis.dependencyTestC_Passed) {
			console.log(
				`%c[DependencySystemC] SUCCESS! Read value ${value} from B. 'B -> C' is working. Full chain A->B->C is correct.`,
				'color: lightgreen',
			)
			globalThis.dependencyTestC_Passed = true
		}
	}
}