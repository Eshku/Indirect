/**
 * A simple kernel that logs its execution to a shared buffer.
 * @param {number} payload - Unused for this kernel.
 * @param {object} systemContext - Contains shared state buffers.
 * @param {object} kernelContext - Unused.
 */
export function loggingKernel(payload, systemContext, kernelContext) {
	const { executionLog, logIndex } = systemContext

	// Atomically get the next available log slot and write our ID to it.
	const index = Atomics.add(logIndex, 0, 1)
	if (index < executionLog.length) {
		Atomics.store(executionLog, index, 3) // 3 represents loggingKernel
	}
}