/**
 * The central, thread-safe API for parallel contexts (kernels).
 * This class provides a single, consistent interface for both workers and the main thread
 * when executing parallelizable jobs.
 *
 * An instance of this class must be created for each execution context (main thread, worker)
 * and is made available to kernels via the global `self.kernel` object.
 *
 * Kernels can access this via the global `kernel` object.
 * e.g., `const positions = self.kernel.getComponentData(chunkId, position);`
 */
export class Kernel {
	/**
	 * @param {object} context
	 * @param {object} context.entityStore The shared entity store.
	 */
	constructor({ entityStore }) {
		if (!entityStore) {
			throw new Error('[Kernel] Initialization failed: `entityStore` is required.')
		}
		this.entityStore = entityStore
	}

	// --- Stateless API for Kernels ---
	// This mirrors the API provided to systems by `systemExtends.js`.

	/**
	 * Retrieves the component data for a specific chunk and component type.
	 * @param {number} chunkId The ID of the chunk.
	 * @param {number} componentTypeId The TypeID of the component.
	 * @returns {object | undefined} The component data object for the chunk, or undefined if not found.
	 */
	getComponentData(chunkId, componentTypeId) {
		const chunkData = this.entityStore.chunkComponentData[chunkId]
		if (!chunkData) {
			console.error(
				`[Worker ${self.id}] Kernel.getComponentData: chunkData for chunkId ${chunkId} is UNDEFINED when requesting component ${componentTypeId}.`,
			)
			return undefined
		}
		return chunkData[componentTypeId]
	}
	getChunkSize(chunkId) {
		return this.entityStore.chunkSizes[chunkId]
	}
	getEntities(chunkId) {
		return this.entityStore.chunkComponentData[chunkId].entities
	}




	//! MOVED FROM CHUNKVIEW, might need to update.
	/**
	 * Signals to the engine that a component type has been modified within this chunk.
	 * This updates the chunk's "high-water mark" for the component, which allows
	 * reactive queries to efficiently detect that this chunk contains changes.
	 *
	 * This is the single, unified method for marking data as dirty for broad-phase culling.
	 * It is safe to call from both the main thread and worker threads.
	 * @param {number} typeId The component type ID to mark.
	 * @param {number} tick The current game tick.
	 */
	markDirty(typeId, tick) {
		const archetypeDirtyTicks = this.entityStore.chunkArchetypeDirtyTicks[this.chunkId]
		const indexInArchetype = this._componentIndexMap.get(typeId)

		// If indexInArchetype is undefined, it means the component is not part of this chunk's archetype.
		if (indexInArchetype === undefined) return

		let oldValue = Atomics.load(archetypeDirtyTicks, indexInArchetype)
		// This is a standard lock-free pattern to "set if greater".
		while (tick > oldValue) {
			const result = Atomics.compareExchange(archetypeDirtyTicks, indexInArchetype, oldValue, tick)
			// If the exchange was successful (we won the race), we're done.
			if (result === oldValue) break
			// If it failed, another thread set a new value. We loop and try again with the new value.
			oldValue = result
		}
	}

	/**
	 * Resets any per-job state within the API.
	 * Must be called by the execution context before processing a new job.
	 */
	resetJobState() {
		// This method is now effectively a no-op as there is no per-job state to reset.
	}
}
