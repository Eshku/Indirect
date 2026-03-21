/**
 * A kernel for the ParallelismTestSystem.
 * It moves entities horizontally and bounces them off the screen edges.
 * @param {number} payload - For this kernel, the payload is the chunkId to process.
 * @param {object} systemContext - A read-only object with properties from the main-thread System instance.
 * @param {object} kernelContext - An object with thread-specific helpers, like getChunkView.
 */
export function parallelismTest(payload, systemContext, kernelContext) {
	const { currentTick } = frameContext
	const { position, velocity, rightBoundary, leftBoundary } = systemContext

	const chunk = parallel.getChunkView(payload)
	const positions = chunk.componentData[position]
	const velocities = chunk.componentData[velocity]

	for (let i = 0; i < chunk.size; i++) {
		positions.x[i] += velocities.x[i]
		if (positions.x[i] > rightBoundary || positions.x[i] < leftBoundary) {
			velocities.x[i] *= -1
		}
	}
	chunk.markDirty(position, currentTick)
}