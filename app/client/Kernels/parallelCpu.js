/**
 * A purely CPU-bound kernel for the ParallelCPUBenchmark system.
 * @param {number} payload - The chunkId to process.
 * @param {object} systemContext - Contains component TypeIDs.
 * @param {object} kernelContext - Contains thread-specific helpers.
 */
export function parallelCpu(payload, systemContext, kernelContext) {
	const { position, velocity } = systemContext
	const { currentTick } = frameContext

	const chunk = parallel.getChunkView(payload)
	const positions = chunk.componentData[position]
	const velocities = chunk.componentData[velocity]

	for (let i = 0; i < chunk.size; i++) {
		// Read initial state once
		let x = positions.x[i]
		let y = velocities.y[i]

		// Perform a lot of computation.
		for (let j = 0; j < 50; j++) {
			const newX = Math.sin(x) * y - Math.cos(y) * x
			const newY = Math.cos(x) * y + Math.sin(y) * x
			x = newX
			y = newY
		}

		// Write the final result once
		positions.x[i] = x
	}
	chunk.markDirty(position, currentTick)
}