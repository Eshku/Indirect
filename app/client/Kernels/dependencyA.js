/**
 * Kernel for DependencySystemA. Writes a known value.
 * @param {number} payload - The chunkId to process.
 * @param {object} systemContext - Contains component TypeIDs.
 * @param {object} kernelContext - Contains thread-specific helpers.
 */
export function dependencyA(payload, systemContext, kernelContext) {
	const { velocity } = systemContext
	const { currentTick } = frameContext

	const chunk = kernelContext.getChunkView(payload)
	const velocities = chunk.componentData[velocity]
	for (let i = 0; i < chunk.size; i++) {
		// Write a specific, known value.
		velocities.x[i] = 123
	}
	chunk.markDirty(velocity, currentTick)
}