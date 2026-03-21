/**
 * A static, chunk-based kernel that moves entities based on their velocity.
 * @param {number} payload - For this kernel, the payload is the chunkId to process.
 * @param {object} systemContext - A read-only object with properties from the main-thread System instance.
 * @param {object} kernelContext - An object with thread-specific helpers, like getChunkView.
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
	const chunk = parallel.getChunkView(payload)

	// Direct data access is more performant and data-oriented than chunk.getComponent().
	const positions = chunk.componentData[position]
	const velocities = chunk.componentData[velocity]

	for (let i = 0; i < chunk.size; i++) {
		positions.x[i] += velocities.x[i] * speed * deltaTime
		positions.y[i] += velocities.y[i] * speed * deltaTime
	}

	// kernel modifies every position in the chunk, we can use the efficient batch method.
	chunk.markDirty(position, frameContext.currentTick)
}
