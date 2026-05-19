/**
 * A standalone, thread-safe module that holds the global execution context for a frame.
 * This includes versioning information for reactivity, timing data, and frame counters.
 * It is built on a SharedArrayBuffer to allow zero-copy access from both the main thread
 * and worker threads.
 *
 * The GameLoop is the sole WRITER. All other systems/managers are READERS.
 */

// Using a cache line size to prevent false sharing.
const CONTEXT_BUFFER_SIZE = 64

const buffer = new SharedArrayBuffer(CONTEXT_BUFFER_SIZE)
const u32View = new Uint32Array(buffer)
const f64View = new Float64Array(buffer)

// --- Layout ---
// We use separate views for different data types.
// U32 view (offsets are in terms of u32 indices)
export const CTX_CURRENT_VERSION_OFFSET = 0
export const CTX_LAST_VERSION_OFFSET = 1
export const CTX_FRAME_ID_OFFSET = 2
// F64 view (offsets are in terms of f64 indices, starting at byte 32 for alignment)
export const CTX_DELTA_TIME_OFFSET = 4 // 4 * 8 = 32 bytes
export const CTX_ALPHA_OFFSET = 5      // 5 * 8 = 40 bytes

// The singleton object to export.
export const executionContext = {
	// The raw buffer for sharing with workers.
	getBuffer: () => buffer,

	/**
	 * Updates the shared context. Called by the GameLoop before an execution block.
	 * @param {object} context
	 * @param {number} context.currentVersion
	 * @param {number} context.lastVersion
	 * @param {number} context.deltaTime
	 * @param {number} context.alpha
	 * @param {number} context.frameCounter
	 */
	update({ currentVersion, lastVersion, deltaTime, alpha, frameCounter }) {
		// A non-atomic write is safe. The main thread is the only writer, and the
		// Atomics.notify() in the Scheduler's _signalNewFrame() provides the
		// necessary memory fence to ensure workers see this updated value.
		u32View[CTX_CURRENT_VERSION_OFFSET] = currentVersion
		u32View[CTX_LAST_VERSION_OFFSET] = lastVersion
		u32View[CTX_FRAME_ID_OFFSET] = frameCounter

		f64View[CTX_DELTA_TIME_OFFSET] = deltaTime
		f64View[CTX_ALPHA_OFFSET] = alpha
	},

	getCurrentVersion() {
		// Direct, allocation-free read.
		return u32View[CTX_CURRENT_VERSION_OFFSET]
	},

	getLastVersion() {
		return u32View[CTX_LAST_VERSION_OFFSET]
	},

	getFrameCounter() {
		return u32View[CTX_FRAME_ID_OFFSET]
	},

	// Note: Atomics do not operate on floats. For deltaTime and alpha, a regular read is
	// acceptable as they are written once per execution block and are not the primary
	// drivers of fine-grained reactivity logic like the version counters.
	getDeltaTime() {
		return f64View[CTX_DELTA_TIME_OFFSET]
	},
}