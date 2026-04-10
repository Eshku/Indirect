/**
 * A purely memory-bound kernel for the MemoryBenchmark system.
 * This kernel performs a read and then a write to the same component data location
 * for entities within a chunk, designed to stress memory bandwidth.
 * @param {number} payload - The chunkId to process.
 * @param {object} systemContext - Contains component TypeIDs.
 * @param {object} kernelContext - Contains thread-specific helpers.
 */
export function parallelMemory(payload, systemContext, kernelContext) {
	const { memoryComponent } = systemContext

	const chunkId = payload

	const memoryComponents = self.kernel.getComponentData(chunkId, memoryComponent)
	const chunkSize = self.kernel.getChunkSize(chunkId)

	for (let i = 0; i < chunkSize; i++) {
		memoryComponents.value[i] = memoryComponents.value[i]
	}
}
