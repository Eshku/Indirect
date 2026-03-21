import { DIRTY_HISTORY_LENGTH } from '../ComponentManager/ComponentSchema.js'

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
		this.metadata = null
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
		this.metadata = this.entityStore.chunkMetadata[chunkId]
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
	 * Scans the bitmask for an enableable component and populates a scratch buffer
	 * with the indices of all entities for which the component is enabled.
	 *
	 * @param {number} componentTypeId The type ID of the component to check.
	 * @param {Uint32Array} scratchBuffer A pre-allocated buffer to write the indices into.
	 * @returns {number} The number of enabled entities found.
	 */
	getEnabledIndices(componentTypeId, scratchBuffer) {
		if (!this.metadata) {
			for (let i = 0; i < this.size; i++) {
				scratchBuffer[i] = i
			}
			return this.size
		}

		const componentMetadata = this.metadata[componentTypeId]
		const enabledMask = componentMetadata?.enabledMask

		if (!enabledMask) {
			// If the component is not enableable, we assume all entities that have it are enabled.
			// This is fallback for non-enableable components.
			for (let i = 0; i < this.size; i++) {
				scratchBuffer[i] = i
			}
			return this.size
		}

		let count = 0
		const numWords = Math.ceil(this.size / 32)

		for (let i = 0; i < numWords; i++) {
			let bits = enabledMask[i]
			if (bits === 0) continue // The "Fast-Skip" (32 entities at once)

			const offset = i << 5
			// "Gather" loop
			while (bits !== 0) {
				const t = bits & -bits // Isolate lowest set bit
				const indexInWord = 31 - Math.clz32(t)
				const entityIndex = offset | indexInWord

				// Final check to ensure we don't read past the actual chunk size
				if (entityIndex >= this.size) break

				scratchBuffer[count++] = entityIndex
				bits ^= t // Clear the bit and repeat
			}
		}
		return count
	}

	/**
	 * Scans the dirty bitmask history for a tracked component and populates a scratch buffer
	 * with the indices of all entities that have changed between the `lastTick` and the
	 * current frame's tick.
	 *
	 * @param {number} componentTypeId The type ID of the component to check.
	 * @param {number} lastTick The last tick the calling system ran.
	 * @param {Uint32Array} scratchBuffer A pre-allocated buffer to write the indices into.
	 * @returns {number} The number of changed entities found.
	 */
	getChangedIndices(componentTypeId, lastTick, scratchBuffer) {
		const dirtyMasks = this.metadata?.[componentTypeId]?.dirtyMasks

		if (!dirtyMasks) {
			// If the component is not tracked, we cannot determine changes.
			// Returning 0 is the safest behavior, as a reactive system should not
			// run if its tracked component doesn't support tracking.
			return 0
		}

		const currentTick = this._lastTick // The Query sets this via _setLastTick
		const numWords = Math.ceil(this.entityStore.chunkCapacities[this.chunkId] / 32)

		// Handle history overflow using the Saturated History model.
		const tickDelta = currentTick - lastTick
		let startTick
		if (tickDelta >= DIRTY_HISTORY_LENGTH) {
			// If overflowed, we start from the oldest available (and saturated) tick in the history.
			startTick = currentTick - DIRTY_HISTORY_LENGTH + 1
		} else {
			startTick = lastTick + 1
		}
		const endTick = currentTick

		if (startTick > endTick) return 0 // No new ticks to process.

		let count = 0
		for (let wordIndex = 0; wordIndex < numWords; wordIndex++) {
			let effectiveMask = 0

			// Accumulate changes over the time window.
			for (let tick = startTick; tick <= endTick; tick++) {
				const frameIndex = tick % DIRTY_HISTORY_LENGTH
				const finalWordIndex = frameIndex * numWords + wordIndex
				// Use Atomics.load for safety, as the maintenance job might be writing to these buffers.
				effectiveMask |= Atomics.load(dirtyMasks, finalWordIndex)
			}

			if (effectiveMask === 0) continue // Fast-skip

			// Gather indices from the effective mask.
			const offset = wordIndex << 5
			while (effectiveMask !== 0) {
				const t = effectiveMask & -effectiveMask // Isolate lowest set bit
				const indexInWord = 31 - Math.clz32(t)
				const entityIndex = offset | indexInWord

				if (entityIndex >= this.size) break

				scratchBuffer[count++] = entityIndex
				effectiveMask ^= t // Clear the bit
			}
		}

		return count
	}

	/**
	 * Marks a specific entity within this chunk as dirty for a given component and tick.
	 * This is the immediate-mode, high-performance API for use inside kernels.
	 * It updates both the narrow-phase bitmask and the broad-phase high-water mark.
	 * @param {number} indexInChunk The entity's index within this chunk.
	 * @param {number} typeId The component type ID to mark.
	 * @param {number} tick The current game tick.
	 */
	markEntityDirty(indexInChunk, typeId, tick) {
		const componentMetadata = this.metadata[typeId]
		const dirtyMasks = componentMetadata.dirtyMasks

		const wordsPerFrame = Math.ceil(this.entityStore.chunkCapacities[this.chunkId] / 32)
		const frameIndex = tick % DIRTY_HISTORY_LENGTH
		const wordIndexInFrame = indexInChunk >>> 5
		const bitMask = 1 << (indexInChunk & 31)
		const finalWordIndex = frameIndex * wordsPerFrame + wordIndexInFrame

		Atomics.or(dirtyMasks, finalWordIndex, bitMask)

		// Always update the broad-phase tick.
		this.markDirty(typeId, tick)
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
