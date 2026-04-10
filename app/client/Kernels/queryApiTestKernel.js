// This kernel will run on worker threads.
// It uses the new `self.kernel` API to interact with chunk data.

// Kernels don't have access to `ecs.getComponentIDs()`.
// The context object, defined in the system's static `dependencies`,
// is the correct way to pass component IDs and other static data to a kernel.

export async function queryApiTestKernel(chunkId, context) {
	// Static context from system dependencies
	const { position } = context
	// Dynamic context from the current frame, available globally in workers.
	const { currentTick } = self.frameContext

	// Use the new stateless API, available on `self.kernel`.
	const chunkSize = self.kernel.getChunkSize(chunkId)

	const positions = self.kernel.getComponentData(chunkId, position)

	// Perform work on the entities in this chunk.
	for (let j = 0; j < chunkSize; j++) {
		positions.x[j] += 0.1 // Pretend to read and write data.
	}
}
