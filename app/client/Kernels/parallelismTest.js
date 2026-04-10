/**
 * A kernel for the ParallelismTestSystem.
 * It moves entities horizontally and bounces them off the screen edges.
 * @param {number} payload - For this kernel, the payload is the chunkId to process.
 * @param {object} systemContext - A read-only object with properties from the main-thread System instance.
 * @param {object} kernelContext - An object with thread-specific helpers.
 */
export function parallelismTest(payload, systemContext, kernelContext) {
	const { currentTick } = frameContext
	const { position, velocity, rightBoundary, leftBoundary } = systemContext

	const chunkId = payload
	const positions = self.kernel.getComponentData(chunkId, position)
	const velocities = self.kernel.getComponentData(chunkId, velocity)
	const chunkSize = self.kernel.getChunkSize(chunkId)

	for (let i = 0; i < chunkSize; i++) {
		positions.x[i] += velocities.x[i]
		if (positions.x[i] > rightBoundary || positions.x[i] < leftBoundary) {
			velocities.x[i] *= -1
		}
	}
	// Marking dirty from kernels is currently disabled.
}