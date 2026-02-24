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
		const componentIdArray = this.entityStore.archetypeComponentTypeIDArrays[this.archetypeId]
		if (!componentIdArray) {
			// This is a critical error indicating a desync between the main thread and worker.
			// It means the worker has a chunk with an archetypeId that it doesn't have the definition for.
			const workerId = typeof self !== 'undefined' && self.id ? `Worker ${self.id}` : 'Main Thread'
			throw new Error(
				`[ChunkView] ${workerId}: Failed to find componentIdArray for archetypeId ${this.archetypeId} in chunk ${this.chunkId}. The worker's archetype definitions are out of sync.`,
			)
		}
		const count = componentIdArray[0]
		for (let i = 1; i <= count; i++) {
			this._componentIndexMap.set(componentIdArray[i], i - 1)
		}
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
	markEntityDirty(typeId, indexInChunk, tick) {
		// 1. Update the per-entity tick.
		this.dirtyTicks[typeId][indexInChunk] = tick

		// 2. Atomically update the per-component-type high-water mark for the chunk.
		const archetypeDirtyTicks = this.entityStore.chunkArchetypeDirtyTicks[this.chunkId]
		const indexInArchetype = this._componentIndexMap.get(typeId)

		let oldValue = Atomics.load(archetypeDirtyTicks, indexInArchetype)
		while (tick > oldValue) {
			const result = Atomics.compareExchange(archetypeDirtyTicks, indexInArchetype, oldValue, tick)
			if (result === oldValue) break
			oldValue = result
		}
	}

	/**
	 * Marks a component type as dirty for ALL entities in the chunk.
	 * This is a highly efficient method for batch operations.
	 * @param {number} typeId The component type ID to mark.
	 * @param {number} tick The current game tick.
	 */
	markAllDirty(typeId, tick) {
		// 1. Update all per-entity ticks for this component type in the chunk.
		this.dirtyTicks[typeId].fill(tick, 0, this.size)

		// 2. Atomically update the per-component-type high-water mark for the chunk.
		const archetypeDirtyTicks = this.entityStore.chunkArchetypeDirtyTicks[this.chunkId]
		const indexInArchetype = this._componentIndexMap.get(typeId)
		let oldValue = Atomics.load(archetypeDirtyTicks, indexInArchetype)
		while (tick > oldValue) {
			const result = Atomics.compareExchange(archetypeDirtyTicks, indexInArchetype, oldValue, tick)
			if (result === oldValue) break
			oldValue = result
		}
	}

	/**
	 * Flushes manually updated per-entity dirty ticks by updating the chunk's high-water mark for a component type.
	 * This is the efficient, data-oriented way to signal changes after a loop.
	 * @param {number} typeId The component type ID that was modified.
	 * @param {number} tick The current game tick.
	 */
	markChunkDirty(typeId, tick) {
		// Atomically update the per-component-type high-water mark for the chunk.
		// This assumes the per-entity ticks have already been set manually.
		const archetypeDirtyTicks = this.entityStore.chunkArchetypeDirtyTicks[this.chunkId]
		const indexInArchetype = this._componentIndexMap.get(typeId)

		let oldValue = Atomics.load(archetypeDirtyTicks, indexInArchetype)
		while (tick > oldValue) {
			const result = Atomics.compareExchange(archetypeDirtyTicks, indexInArchetype, oldValue, tick)
			if (result === oldValue) break
			oldValue = result
		}
	}
}
