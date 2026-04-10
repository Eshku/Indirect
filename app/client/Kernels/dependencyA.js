/**
 * Kernel for DependencySystemA. Writes a known value.
 * @param {number} payload - The chunkId to process.
 * @param {object} systemContext - Contains component TypeIDs.
 * @param {object} kernelContext - Contains thread-specific helpers.
 */
export function dependencyA(payload, systemContext, kernelContext) {
	const chunkId = payload
	const { velocity } = systemContext
	const { currentTick } = frameContext

	const velocities = self.kernel.getComponentData(chunkId, velocity)
	const chunkSize = self.kernel.getChunkSize(chunkId)
	for (let i = 0; i < chunkSize; i++) {
		// Write a specific, known value.
		velocities.x[i] = 123
	}
}