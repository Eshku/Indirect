/**
 * The central, thread-safe API for parallel contexts (kernels).
 * This class provides a single, consistent interface for both workers and the main thread
 * when executing parallelizable jobs.
 *
 * An instance of this class must be created for each execution context (main thread, worker)
 * and is typically made available to kernels via a global `parallel` object.
 *
 * Kernels can access this via the global `parallel` object.
 * e.g., `const chunk = parallel.getChunkView(payload);`
 */
export class ParallelAPI {
	/**
	 * @param {object} context
	 * @param {import('../../Managers/QueryManager/ChunkView.js').ChunkView[]} context.pool - The pool of ChunkView instances for this context.
	 */
	constructor(context) {
		if (!context || !Array.isArray(context.pool)) {
			throw new Error('[ParallelAPI] Initialization failed: context with a `pool` array of ChunkViews is required.')
		}
		/** @private */
		this.chunkViewPool = context.pool
		/** @private */
		this.chunkViewPoolIndex = 0
	}

	/**
	 * Retrieves a reusable ChunkView instance from the context's pool.
	 * If a chunkId is provided, it automatically sets the view to that chunk.
	 * @param {number} [chunkId] - The ID of the chunk to view.
	 * @returns {import('../../Managers/QueryManager/ChunkView.js').ChunkView}
	 */
	getChunkView(chunkId) {
		if (this.chunkViewPoolIndex >= this.chunkViewPool.length) {
			throw new Error(
				`[ParallelAPI] ChunkView pool exhausted. A single kernel requested more than ${this.chunkViewPool.length} views. Increase the pool size if this is intentional.`,
			)
		}

		const view = this.chunkViewPool[this.chunkViewPoolIndex++]
		if (chunkId !== undefined) {
			view.setChunk(chunkId)
		}
		return view
	}

	/**
	 * Resets any per-job state within the API.
	 * Must be called by the execution context before processing a new job.
	 */
	resetJobState() {
		this.chunkViewPoolIndex = 0
	}
}