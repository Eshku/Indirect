/**
 * A collection of utility functions for debugging timing and concurrency behaviors.
 * These functions are primarily intended for development and testing purposes.
 */
/**
 * Stalls the execution of the current thread for a specified duration.
 * This is a blocking operation and will freeze the thread it's called on.
 * Useful for simulating heavy synchronous workloads or creating artificial contention.
 *
 * @param {number} ms The number of milliseconds to stall.
 */
export const stall = ms => {
	const start = performance.now()
	while (performance.now() - start < ms) {
		// Busy-wait
	}
}

/**
 * Pauses the execution asynchronously for a specified duration without blocking the thread.
 * This is equivalent to an "async sleep" and yields control back to the event loop.
 *
 * When called with `await` (e.g., `await sleep(100)`), the `async` function containing
 * the `await` call will pause, allowing other tasks in the event loop to run.
 *
 * When called without `await` (e.g., `sleep(100)`), the function returns a Promise
 * immediately, and execution continues to the next line. The delay still occurs,
 * but no code will wait for it to complete. This is generally less useful for
 * creating sequential delays and is often referred to as "fire-and-forget".
 *
 * @example
 * // Usage with await (inside an async function):
 * async function delayedAction() {
 *   console.log("Starting delay...");
 *   await sleep(1000); // Pauses for 1 second, non-blocking
 *   console.log("Delay finished!");
 * }
 *
 * @param {number} ms The number of milliseconds to sleep.
 * @returns {Promise<void>} A promise that resolves after the specified duration.
 */
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
