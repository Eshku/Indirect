import { MASK_PARTS, MAX_COMPONENTS } from '../ComponentManager/ComponentSchema.js'

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
		// A reusable scratch buffer to avoid allocations in createComponentMask.
		this.tempMask = new BigUint64Array(MASK_PARTS)
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

	/**
	 * Checks if a given entity has a set of components.
	 * This is a thread-safe, read-only operation, perfect for relationship traversal.
	 * @param {bigint} entityId The ID of the entity to check.
	 * @param {BigUint64Array} componentMask The mask of components to check for, created with `createComponentMask`.
	 * @returns {boolean} True if the entity has all components in the mask.
	 */
	entityHasComponents(entityId, componentMask) {
		const entityIndex = Number(entityId & 0xffffffffn)

		// This is a direct, non-atomic read. It's safe because the main thread is the sole writer
		// and workers are sole readers of this data during the parallel execution phase.
		// The memory visibility is guaranteed by the scheduler's frame synchronization barriers.
		const packedLocation = this.entityStore.entityPackedLocations[entityIndex]

		if (packedLocation === 0) {
			return false // Entity is not active or has no components.
		}

		const archetypeId = packedLocation >> 16
		const archetypeMaskOffset = archetypeId * MASK_PARTS

		// Check if the entity's archetype mask contains all bits from the componentMask.
		for (let i = 0; i < MASK_PARTS; i++) {
			const entityMaskPart = this.entityStore.archetypeMasks[archetypeMaskOffset + i]
			const checkMaskPart = componentMask[i]
			if ((entityMaskPart & checkMaskPart) !== checkMaskPart) {
				return false
			}
		}

		return true
	}

	/**
	 * Creates a component mask from a list of component type IDs.
	 * This is a helper for use within kernels to create masks for `entityHasComponents`.
	 * The returned mask is a reference to an internal, reusable buffer and should not be stored.
	 * @param {number[]} componentTypeIDs An array of component type IDs.
	 * @returns {BigUint64Array} A reference to an internal, reusable mask. Do not store this reference.
	 */
	createComponentMask(componentTypeIDs) {
		this.tempMask.fill(0n)
		for (const typeID of componentTypeIDs) {
			if (typeID >= MAX_COMPONENTS) {
				// This check is important for worker stability.
				console.error(`[Kernel] createComponentMask: Component type ID ${typeID} exceeds MAX_COMPONENTS.`)
				continue
			}
			const partIndex = Math.floor(typeID / 64)
			const bitInPart = typeID % 64
			this.tempMask[partIndex] |= 1n << BigInt(bitInPart)
		}
		return this.tempMask
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
