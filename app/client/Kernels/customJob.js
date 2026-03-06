/**
 * A kernel to demonstrate custom jobs and dynamic requests.
 * @param {number} payload - A custom, non-chunkId payload.
 * @param {object} systemContext - Contains the request buffer.
 * @param {object} kernelContext - Unused.
 */
export function customJob(payload, systemContext, kernelContext) {
	const { requestBuffer, resultBuffer, logVerbose } = systemContext

	// 1. Log the custom payload to show it was received.
	// We only want to log this once per frame to avoid spam.
	if (logVerbose && !self.hasRunCustomJobTest) {
		console.log(
			`%c[CustomJobKernel] Received custom payload: ${payload}. This is not a chunkId!`,
			'color: lightgreen',
		)
		self.hasRunCustomJobTest = true
	}

	// 2. Process the "dynamic request" from the request buffer.
	// In a real system, this might be a loop processing many requests.
	const requestValue = Atomics.load(requestBuffer, 0)

	if (requestValue !== 0) {
		// Process the request and write a result.
		const result = requestValue * 10
		Atomics.store(resultBuffer, 0, result)
		Atomics.store(requestBuffer, 0, 0) // Clear the request
	}
}