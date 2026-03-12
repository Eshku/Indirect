const ARCHETYPE_STORE_PAGE_SIZE_IN_BYTES = 4096 // 4KB page for component IDs
const ARCHETYPE_STORE_PAGE_SIZE_IN_U16 = ARCHETYPE_STORE_PAGE_SIZE_IN_BYTES / Uint16Array.BYTES_PER_ELEMENT

/**
 * A lightweight, reusable "flyweight" accessor for a chunk's data.
 * This is the JavaScript equivalent of Unity's `ArchetypeChunk` object,
 * designed to be provided by a query to a system. The same instance is
 * reused for each iteration of a query loop to avoid allocations.
 *
 * ### Best Practice for Data Access
 *
 * For maximum performance, systems should access the `componentData` property
 * directly rather than using the `getComponent(typeId)` helper inside a loop.
 * The `componentData` object contains the raw `TypedArray`s for the chunk's
 * components, keyed by their numeric `typeID`. Accessing it directly allows
 * for more efficient, hoisted lookups.
 *
 * In a worker context, this class is instantiated once and reused for each
 * job, pointing to the data for the job's assigned chunkId.
 */
export class ChunkView {
	constructor(entityStore) {
		this.entityStore = entityStore
		this.chunkId = -1
		this.size = 0
		this.archetypeId = -1
		this.entities = null
		this.componentData = null
		this._lastTick = -1
		this._componentIndexMap = new Map()
	}

	/**
	 * Sets the view to a specific chunk.
	 * On the main thread, it uses the entityStore.
	 * On a worker, it also uses the entityStore, as it's shared.
	 * @param {number} chunkId
	 */
	setChunk(chunkId) {
		this.chunkId = chunkId
		this.size = this.entityStore.chunkSizes[chunkId]
		this.archetypeId = this.entityStore.chunkArchetypeIds[chunkId]
		this.componentData = this.entityStore.chunkComponentData[chunkId]
		this.entities = this.componentData.entities
		this._buildComponentIndexMap()
	}

	/**
	 * Builds a cache mapping component type IDs to their 0-based index within the archetype's component list.
	 * This is a small, one-time cost per chunk iteration that makes subsequent lookups O(1).
	 * @private
	 */
	_buildComponentIndexMap() {
		this._componentIndexMap.clear()
		const componentIdArray = this._getComponentTypeIDsForArchetype(this.archetypeId)
		// returns an empty array if the archetype is not found
		for (let i = 0; i < componentIdArray.length; i++) {
			this._componentIndexMap.set(componentIdArray[i], i)
		}
	}

	/**
	 * Worker-side implementation to read component IDs from the paged buffer.
	 * This is a copy of the logic in EntityManager.
	 * @param {number} archetypeId
	 * @returns {Uint16Array}
	 * @private
	 */
	_getComponentTypeIDsForArchetype(archetypeId) {
		const count = this.entityStore.archetypeComponentCounts[archetypeId]
		if (count === undefined || count === 0) return new Uint16Array(0)

		const result = new Uint16Array(count)
		const globalStartIndex = this.entityStore.archetypeComponentListStartIndices[archetypeId]

		let written = 0
		while (written < count) {
			const globalReadIndex = globalStartIndex + written
			const pageIndex = Math.floor(globalReadIndex / ARCHETYPE_STORE_PAGE_SIZE_IN_U16)
			const indexInPage = globalReadIndex % ARCHETYPE_STORE_PAGE_SIZE_IN_U16
			const page = this.entityStore.packedComponentIdPages[pageIndex]
			const toRead = Math.min(count - written, ARCHETYPE_STORE_PAGE_SIZE_IN_U16 - indexInPage)

			result.set(page.subarray(indexInPage, indexInPage + toRead), written)
			written += toRead
		}
		return result
	}

	_setLastTick(tick) {
		this._lastTick = tick
	}

	/**
	 * A convenience helper to get the component data object for a given type ID.
	 * For performance-critical code, it is recommended to access `chunk.componentData[typeId]` directly.
	 * @param {number} typeId
	 */
	getComponent(typeId) {
		return this.componentData[typeId]
	}

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
		// Atomically update the per-component-type high-water mark for the chunk.
		// This signals to reactive queries that this component type has changed within this chunk.
		this._updateArchetypeDirtyTick(typeId, tick)
	}

	/**
	 * Atomically updates the per-component-type high-water mark for this chunk.
	 * This is a lock-free "set if greater" operation.
	 * @param {number} typeId The component type ID to update.
	 * @param {number} tick The current game tick.
	 * @private
	 */
	_updateArchetypeDirtyTick(typeId, tick) {
		const archetypeDirtyTicks = this.entityStore.chunkArchetypeDirtyTicks[this.chunkId]
		const indexInArchetype = this._componentIndexMap.get(typeId)

		// This check is important. It can be undefined if a system tries to mark a component
		// that isn't actually in the chunk's archetype, which is a developer error.
		if (indexInArchetype === undefined) {
			return
		}

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
}
