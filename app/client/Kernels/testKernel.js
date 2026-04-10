/**
 * A static, chunk-based kernel that moves entities based on their velocity.
 * @param {number} payload - For this kernel, the payload is the chunkId to process.
 * @param {object} systemContext - A read-only object with properties from the main-thread System instance.
 * @param {object} kernelContext - An object with thread-specific helpers.
 */
export function testKernel(payload, systemContext, kernelContext) {
	// Log execution for dependency testing.
	const { executionLog, logIndex } = systemContext
	if (executionLog && logIndex) {
		const index = Atomics.add(logIndex, 0, 1)
		if (index < executionLog.length) {
			Atomics.store(executionLog, index, 2) // 2 represents testKernel
		}
	}

	const { deltaTime } = frameContext
	// 'speed' and component TypeIDs are passed from the system instance via the context.
	const { speed, position, velocity } = systemContext

	// The kernel is responsible for interpreting the payload.
	const chunkId = payload

	const positions = self.kernel.getComponentData(chunkId, position)
	const velocities = self.kernel.getComponentData(chunkId, velocity)
	const chunkSize = self.kernel.getChunkSize(chunkId)

	for (let i = 0; i < chunkSize; i++) {
		positions.x[i] += velocities.x[i] * speed * deltaTime
		positions.y[i] += velocities.y[i] * speed * deltaTime
	}

	// kernel modifies every position in the chunk, we can use the efficient batch method.
	// Marking dirty from kernels is currently disabled.
}
