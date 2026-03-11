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
		this.dirtyTicks = null
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
		this.dirtyTicks = this.entityStore.chunkDirtyTicks[chunkId]
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

	getDirtyTicks(typeId) {
		return this.dirtyTicks[typeId]
	}

	/**
	 * Checks if a specific component on a specific entity has changed since the system last ran.
	 * @param {number} typeId The component type ID to check.
	 * @param {number} indexInChunk The entity's index within the chunk.
	 * @returns {boolean} True if the component was modified.
	 */
	hasChanged(typeId, indexInChunk) {
		return this.dirtyTicks[typeId][indexInChunk] > this._lastTick
	}

	/**
	 * Checks if any of a list of components on a specific entity has changed since the system last ran.
	 * This is a convenience helper to avoid multiple `||` conditions in a system's loop.
	 * @param {number[]} typeIds An array of component type IDs to check.
	 * @param {number} indexInChunk The entity's index within the chunk.
	 * @returns {boolean} True if any of the components were modified.
	 */
	hasAnyChanged(typeIds, indexInChunk) {
		for (let i = 0; i < typeIds.length; i++) {
			const typeId = typeIds[i]
			if (this.dirtyTicks[typeId][indexInChunk] > this._lastTick) {
				return true
			}
		}
		return false
	}

	/**
	 * Marks a single component on a single entity as dirty.
	 * This updates both the per-entity tick and the per-component-type high-water mark for the chunk.
	 * This is the standard method to use when modifying component data.
	 * @param {number} typeId The component type ID to mark.
	 * @param {number} indexInChunk The entity's index within the chunk.
	 * @param {number} tick The current game tick.
	 */

	//! entity-level dirty tracking going to be removed
	//! and replaced with manually defined, as part of components.
	//! it is rarely useful to mark per entity in a loop 
	//! benefits only if amount of entities marked <10% of whole iteration
	//! while it adds engine complexity, including command buffer.

	//! engine-level support will stay only on broad-phase.

	markEntityDirty(typeId, indexInChunk, tick) {
		// 1. Update the per-entity tick.
		this.dirtyTicks[typeId][indexInChunk] = tick
		// 2. Atomically update the per-component-type high-water mark for the chunk.
		this._updateArchetypeDirtyTick(typeId, tick)
	}

	/**
	 * Flushes manually updated per-entity dirty ticks by updating the chunk's high-water mark for a component type.
	 * This is the efficient, data-oriented way to signal changes after a loop where per-entity ticks were set manually.
	 * @param {number} typeId The component type ID to mark.
	 * @param {number} tick The current game tick.
	 */
	markChunkDirty(typeId, tick) {
		// Atomically update the per-component-type high-water mark for the chunk.
		// This assumes the per-entity ticks have already been set manually.
		this._updateArchetypeDirtyTick(typeId, tick)
	}

	/**
	 * Marks a component type as dirty for ALL entities in the chunk.
	 * This is a highly efficient method for batch operations.
	 * @param {number} typeId The component type ID that was modified.
	 * @param {number} tick The current game tick.
	 */
	markAllDirty(typeId, tick) {
		// 1. Update all per-entity ticks for this component type in the chunk.
		this.dirtyTicks[typeId].fill(tick, 0, this.size)

		// 2. Atomically update the per-component-type high-water mark for the chunk.
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
