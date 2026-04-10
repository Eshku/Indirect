const { entityStore } = await import(`@managers/EntityManager/EntityManager.js`)
import { DIRTY_HISTORY_LENGTH } from '../ComponentManager/ComponentSchema.js'

const { NULL_CHUNK_ID, MAX_COMPONENTS, MASK_PARTS } = await import(`@managers/EntityManager/EntityManager.js`)

export class Query {
	static _createSimpleMask(componentTypeIDs, categoryName) {
		const mask = new BigUint64Array(MASK_PARTS)
		for (const typeID of componentTypeIDs) {
			if (typeof typeID !== 'number') {
				throw new Error(`Query: ${categoryName} component identifier must be a numeric typeID. Received: ${typeID}`)
			}
			if (typeID >= MAX_COMPONENTS) {
				throw new Error(
					`Query: ${categoryName} component with typeID "${typeID}" exceeds MAX_COMPONENTS (${MAX_COMPONENTS}).`,
				)
			}
			const partIndex = Math.floor(typeID / 64)
			const bitInPart = typeID % 64
			mask[partIndex] |= 1n << BigInt(bitInPart)
		}
		return mask
	}

	static _createComponentTypeIDSet(componentTypeIDs, categoryName) {
		const typeIDs = new Set()

		for (const typeID of componentTypeIDs) {
			if (typeof typeID !== 'number') {
				throw new Error(`Query: ${categoryName} component identifier must be a numeric typeID. Received: ${typeID}`)
			}
			typeIDs.add(typeID)
		}
		return Object.freeze(typeIDs)
	}

	constructor(
		id,
		queryManager,
		withComponents = [],
		withoutComponents = [],
		anyComponents = [],
		modifiedComponents = [],
		addedComponents = [],
		removedComponents = [],
	) {
		this.id = id
		this.queryManager = queryManager

		// --- DX: Normalize single values to arrays ---
		const normalize = comps => (comps ? (Array.isArray(comps) ? comps : [comps]) : [])
		const normalizedWith = normalize(withComponents)
		const normalizedWithout = normalize(withoutComponents)
		const normalizedAny = normalize(anyComponents)
		const normalizedModified = normalize(modifiedComponents)
		const normalizedAdded = normalize(addedComponents)
		const normalizedRemoved = normalize(removedComponents)

		this.with = Query._createComponentTypeIDSet(normalizedWith, 'With')
		this.without = Query._createComponentTypeIDSet(normalizedWithout, 'Without')
		this.any = Query._createComponentTypeIDSet(normalizedAny, 'AnyOf')
		this.modified = Query._createComponentTypeIDSet(normalizedModified, 'Modified')
		this.added = Query._createComponentTypeIDSet(normalizedAdded, 'Added')
		this.removed = Query._createComponentTypeIDSet(normalizedRemoved, 'Removed')

		// required mask only includes components that MUST be present.
		const withMask = Query._createSimpleMask(normalizedWith, 'With')
		this._requiredMask = new BigUint64Array(MASK_PARTS)
		for (let i = 0; i < MASK_PARTS; i++) {
			this._requiredMask[i] = withMask[i]
		}

		// reactive mask includes components whose modification, addition, or removal
		// makes the query reactive.
		this._reactiveMask = Query._createSimpleMask(
			[...normalizedModified, ...normalizedAdded, ...normalizedRemoved],
			'Reactive',
		)

		// Specific masks for each reactivity type.
		this._modifiedMask = Query._createSimpleMask(normalizedModified, 'Modified')
		this._addedMask = Query._createSimpleMask(normalizedAdded, 'Added')
		this._removedMask = Query._createSimpleMask(normalizedRemoved, 'Removed')

		// Excluded and AnyOf masks remain unchanged.
		this._excludedMask = Query._createSimpleMask(withoutComponents, 'Without')
		this._anyOfMask = Query._createSimpleMask(anyComponents, 'AnyOf')

		this.isReactiveQuery = this._reactiveMask.some(part => part > 0n)
		this._anyOfMaskIsNonZero = this._anyOfMask.some(part => part > 0n)

		this.matchingChunkIds = []
		this.matchingArchetypeIds = new Set()

		if (this.isReactiveQuery) {
			this._reactiveIndicesByArchetype = []
			// The main API change: getChunks becomes the smart method.
			this.getChunks = this.getReactiveChunks
		} else {
			this.getChunks = this.getAllChunks
		}

		// --- New properties for primed ticks ---
		// These are "primed" by the Scheduler before a system group runs.
		this.iterationLastTick = -1
		this.iterationCurrentTick = 0
	}

	/**
	 * Gets the entity ID of the first entity that matches this query.
	 * This is a convenience method for queries that are expected to match only one entity (e.g., singletons like a player or director).
	 * @returns {bigint | undefined} The entity ID, or undefined if the query is empty.
	 */
	getSingleEntity() {
		// Iterate through chunks directly.
		for (const chunkId of this.matchingChunkIds) {
			if (entityStore.chunkSizes[chunkId] > 0) {
				// Return the first entity from the first non-empty chunk.
				return entityStore.chunkComponentData[chunkId].entities[0]
			}
		}
		return undefined
	}

	/**
	 * Gets the total number of entities matching this query.
	 * @returns {number}
	 */
	get count() {
		let total = 0
		for (const chunkId of this.matchingChunkIds) {
			total += entityStore.chunkSizes[chunkId]
		}
		return total
	}

	/**
	 * Gets a direct reference to the array of chunk IDs whose archetypes match this query.
	 * This is the primary, high-performance method for accessing chunks that match a query's structural requirements.
	 *
	 * If the query is reactive, this method will automatically return only the chunks that have changed since the
	 * last time the query was "primed" with tick data by the Scheduler. For non-reactive queries, it returns all
	 * structurally matching chunks.
	 *
	 * @returns {number[]} A direct reference to the array of matching chunk IDs. Do not mutate this array.
	 */
	getChunks() {
		// This method is a placeholder. The actual implementation is assigned in the constructor
		// based on whether the query is reactive. This provides a clear JSDoc entry point.
		return this.matchingChunkIds
	}

	/**
	 * Gets all chunks that structurally match the query, bypassing any reactive filters.
	 * This is useful if you have a reactive query but need to iterate over all of its
	 * matching entities for a specific reason.
	 * @returns {number[]} A direct reference to the array of all matching chunk IDs.
	 */
	getAllChunks() {
		return this.matchingChunkIds
	}

	/**
	 * For reactive queries, this method filters the query's chunks down to only those that have seen a relevant change.
	 * It uses the `iterationLastTick` and `iterationCurrentTick` properties, which are "primed" by the Scheduler
	 * before system execution. This is an explicit way to get reactive chunks, but using `getChunks()` is preferred for reactive queries.
	 * @returns {number[]} An array of chunk IDs that have changed.
	 */
	getReactiveChunks() {
		const lastTick = this.iterationLastTick
		const currentTick = this.iterationCurrentTick
		const changedChunks = []
		for (let i = 0; i < this.matchingChunkIds.length; i++) {
			const chunkId = this.matchingChunkIds[i]
			if (entityStore.chunkSizes[chunkId] > 0) {
				let isDirtyForQuery = false

				// 1. Check for `modified`
				const archetypeDirtyTicks = entityStore.chunkArchetypeDirtyTicks[chunkId]
				if (archetypeDirtyTicks) {
					const archetypeId = entityStore.chunkArchetypeIds[chunkId]
					const reactiveIndices = this._reactiveIndicesByArchetype[archetypeId]
					if (reactiveIndices?.modified) {
						for (const index of reactiveIndices.modified) {
							const dirtyTick = Atomics.load(archetypeDirtyTicks, index)
							if (this.id === 1 && chunkId === 1) { // Log only for a specific query/chunk to reduce spam
								console.log(`[Query] Checking chunk ${chunkId}, component index ${index}. dirtyTick: ${dirtyTick}, lastTick: ${lastTick}. Condition: ${dirtyTick > lastTick}`)
							}
							if (dirtyTick > lastTick) {
								isDirtyForQuery = true
								break
							}
						}
					}
				}

				// 2. Check for `added`
				if (!isDirtyForQuery) {
					const addedMasksRing = entityStore.chunkAddedComponentMasks[chunkId]
					if (addedMasksRing) {
						const startTick = lastTick + 1
						const endTick = currentTick
						for (let tick = startTick; tick <= endTick; tick++) {
							const tickSlot = tick % DIRTY_HISTORY_LENGTH
							const maskOffset = tickSlot * MASK_PARTS
							for (let part = 0; part < MASK_PARTS; part++) {
								if ((Atomics.load(addedMasksRing, maskOffset + part) & this._addedMask[part]) !== 0n) {
									isDirtyForQuery = true
									break
								}
							}
							if (isDirtyForQuery) break
						}
					}
				}

				// 3. Check for `removed`
				if (!isDirtyForQuery) {
					const removedMasksRing = entityStore.chunkRemovedComponentMasks[chunkId]
					if (removedMasksRing) {
						const startTick = lastTick + 1
						const endTick = currentTick
						for (let tick = startTick; tick <= endTick; tick++) {
							const tickSlot = tick % DIRTY_HISTORY_LENGTH
							const maskOffset = tickSlot * MASK_PARTS
							for (let part = 0; part < MASK_PARTS; part++) {
								if ((Atomics.load(removedMasksRing, maskOffset + part) & this._removedMask[part]) !== 0n) {
									isDirtyForQuery = true
									break
								}
							}
							if (isDirtyForQuery) break
						}
					}
				}

				if (isDirtyForQuery) {
					changedChunks.push(chunkId)
				}
			}
		}
		return changedChunks
	}

	/**
	 * Gets a direct reference to the Set of archetype IDs that match this query.
	 * This is a high-performance method for accessing the structural archetypes that match a query.
	 *
	 * @returns {Set<number>} A direct reference to the Set of matching archetype IDs. Do not mutate this set.
	 */
	getArchetypes() {
		return this.matchingArchetypeIds
	}

	registerArchetype(archetype) {
		if (this.archetypeMatches(archetype)) {
			// If we already know about this archetype, do nothing.
			if (this.matchingArchetypeIds.has(archetype)) {
				return
			}

			// Traverse the archetype's linked list of chunks and add them.
			let chunkId = entityStore.archetypeHeadChunkIds[archetype]
			while (chunkId !== NULL_CHUNK_ID) {
				this.matchingChunkIds.push(chunkId)
				chunkId = entityStore.chunkNextInArchetype[chunkId]
			}
			this.matchingArchetypeIds.add(archetype)

			// Notify the QueryManager so it can add this query to its archetype-based index.
			this.queryManager._addQueryToArchetypeIndex(this, archetype)

			if (this.isReactiveQuery) {
				const componentIdArray = this.queryManager.entityManager.getComponentTypeIDsForArchetype(archetype)
				const count = componentIdArray.length
				const indices = {
					modified: [],
				}

				for (const typeId of this.modified) {
					// Perform a binary search to find the index of the component in the archetype's sorted list.
					let low = 0,
						high = count - 1
					while (low <= high) {
						const mid = (low + high) >>> 1
						const midVal = componentIdArray[mid]
						if (midVal === typeId) {
							indices.modified.push(mid) // The index in the dirty tick array is 0-based.
							break
						} else if (midVal < typeId) {
							low = mid + 1
						} else {
							high = mid - 1
						}
					}
				}
				this._reactiveIndicesByArchetype[archetype] = indices
			}
		}
	}

	/**
	 * Registers a new chunk for an archetype that this query is already tracking.
	 * @param {number} archetypeId The archetype ID.
	 * @param {number} newChunkId The new chunk ID.
	 */
	registerChunk(archetypeId, newChunkId) {
		if (this.matchingArchetypeIds.has(archetypeId)) {
			this.matchingChunkIds.push(newChunkId)
		}
	}

	/**
	 * Unregisters a chunk that is being recycled.
	 * @param {number} archetypeId The archetype ID the chunk belonged to.
	 * @param {number} chunkId The chunk ID to remove.
	 */
	unregisterChunk(archetypeId, chunkId) {
		if (this.matchingArchetypeIds.has(archetypeId)) {
			this._removeChunkId(chunkId)
		}
	}

	archetypeMatches(archetype) {
		const archetypeMaskOffset = archetype * MASK_PARTS

		// Check required components
		for (let i = 0; i < MASK_PARTS; i++) {
			const part = entityStore.archetypeMasks[archetypeMaskOffset + i]
			if ((part & this._requiredMask[i]) !== this._requiredMask[i]) {
				return false
			}
		}

		// Check excluded components
		for (let i = 0; i < MASK_PARTS; i++) {
			const part = entityStore.archetypeMasks[archetypeMaskOffset + i]
			if ((part & this._excludedMask[i]) !== 0n) {
				return false
			}
		}

		// Check anyOf components
		if (this._anyOfMaskIsNonZero) {
			let hasAny = false
			for (let i = 0; i < MASK_PARTS; i++) {
				const part = entityStore.archetypeMasks[archetypeMaskOffset + i]
				if ((part & this._anyOfMask[i]) !== 0n) {
					hasAny = true
					break
				}
			}
			if (!hasAny) {
				return false
			}
		}

		return true
	}

	unregisterArchetype(deletedArchetype) {
		if (this.matchingArchetypeIds.has(deletedArchetype)) {
			// Remove the chunks associated with the deleted archetype
			const chunksToRemove = new Set()
			let chunkId = entityStore.archetypeHeadChunkIds[deletedArchetype]
			while (chunkId !== NULL_CHUNK_ID) {
				chunksToRemove.add(chunkId)
				chunkId = entityStore.chunkNextInArchetype[chunkId]
			}
			if (chunksToRemove.size > 0) this.matchingChunkIds = this.matchingChunkIds.filter(id => !chunksToRemove.has(id))

			this.matchingArchetypeIds.delete(deletedArchetype)
			// Notify the QueryManager so it can remove this query from its archetype-based index.
			this.queryManager._removeQueryFromArchetypeIndex(this, deletedArchetype)

			if (this.isReactiveQuery) {
				this._reactiveIndicesByArchetype[deletedArchetype] = undefined
			}
		}
	}

	/**
	 * Clears all archetype-related data from this query.
	 * Called when the world is reset.
	 */
	clearArchetypes() {
		this.matchingChunkIds.length = 0
		this.matchingArchetypeIds.clear()
		if (this.isReactiveQuery) {
			this._reactiveIndicesByArchetype.length = 0
		}
	}

	_removeChunkId(chunkId) {
		const index = this.matchingChunkIds.indexOf(chunkId)
		if (index > -1) {
			// Fast removal by swapping with the last element.
			this.matchingChunkIds[index] = this.matchingChunkIds[this.matchingChunkIds.length - 1]
			this.matchingChunkIds.pop()
		}
	}

	destroy() {
		this.queryManager.destroyQuery(this)
	}
}
