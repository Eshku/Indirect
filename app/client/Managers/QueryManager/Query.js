/**
 * Represents a declarative query for entities with a specific set of components.
 *
 * --- ARCHITECTURAL NOTE on Query Design (Unity IJobChunk-Style) ---
 *
 * Design of our query system is inspired model used in
 * Unity's Data-Oriented Technology Stack (DOTS).
 *
 * 1.  **A Single, Consistent API**: `query.iter()` method is single entry point
 *     for all iteration. It yields each **Chunk** of entities that match query's
 *     structural definition. A Chunk is a small, cache-friendly block of entities.
 *
 * 2.  **Unified Inner Loop**: Systems iterate over chunks and then over entities
 *     within them. This allows for a perfectly consistent inner loop, regardless of
 *     whether the query is reactive or not.
 *
 *
 */

import { ChunkView } from './ChunkView.js'
const { entityStore } = await import(`@managers/EntityManager/EntityManager.js`)

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

	constructor(id, queryManager, withComponents = [], withoutComponents = [], anyComponents = [], reactComponents = []) {
		this.id = id
		this.queryManager = queryManager
		this.iterationLastTick = null

		// --- DX Improvement: Normalize single values to arrays ---
		const normalize = comps => (comps ? (Array.isArray(comps) ? comps : [comps]) : [])
		const normalizedWith = normalize(withComponents)
		const normalizedWithout = normalize(withoutComponents)
		const normalizedAny = normalize(anyComponents)
		const normalizedReact = normalize(reactComponents)

		this.with = Query._createComponentTypeIDSet(normalizedWith, 'With')
		this.without = Query._createComponentTypeIDSet(normalizedWithout, 'Without')
		this.any = Query._createComponentTypeIDSet(normalizedAny, 'AnyOf')
		this.react = Query._createComponentTypeIDSet(normalizedReact, 'React')

		const withMask = Query._createSimpleMask(normalizedWith, 'With')
		const reactMask = Query._createSimpleMask(normalizedReact, 'React')
		this._requiredMask = new BigUint64Array(MASK_PARTS)
		for (let i = 0; i < MASK_PARTS; i++) {
			this._requiredMask[i] = withMask[i] | reactMask[i]
		}
		this._excludedMask = Query._createSimpleMask(withoutComponents, 'Without')
		this._anyOfMask = Query._createSimpleMask(anyComponents, 'AnyOf')
		this._reactiveMask = reactMask

		this.isReactiveQuery = this._reactiveMask.some(part => part > 0n)
		this._anyOfMaskIsNonZero = this._anyOfMask.some(part => part > 0n)

		this.matchingChunkIds = []
		this._chunkView = new ChunkView(entityStore)
		this.matchingArchetypeIds = new Set()

		if (this.isReactiveQuery) {
			this._reactiveIndicesByArchetype = []
		}

		if (this.isReactiveQuery) {
			this.iter = this._iterChangedArchetypes
		} else {
			this.iter = this._iterAllArchetypes
		}
	}

	iter() {
		throw new Error('Query iterator not initialized.')
	}

	*_iterAllArchetypes() {
		for (let i = 0; i < this.matchingChunkIds.length; i++) {
			const chunkId = this.matchingChunkIds[i]
			if (entityStore.chunkSizes[chunkId] > 0) {
				this._chunkView.setChunk(chunkId)
				yield this._chunkView
			}
		}
	}

	*_iterChangedArchetypes() {
		const lastTick = this.iterationLastTick

		this._chunkView._setLastTick(lastTick)

		for (let i = 0; i < this.matchingChunkIds.length; i++) {
			const chunkId = this.matchingChunkIds[i]
			if (entityStore.chunkSizes[chunkId] > 0) {
				const archetypeId = entityStore.chunkArchetypeIds[chunkId]
				const reactiveIndices = this._reactiveIndicesByArchetype[archetypeId]
				const archetypeDirtyTicks = entityStore.chunkArchetypeDirtyTicks[chunkId]

				if (!reactiveIndices || !archetypeDirtyTicks) continue

				let isDirtyForQuery = false
				// This is the core optimization: we only check the few component types this query cares about.
				for (const index of reactiveIndices) {
					if (Atomics.load(archetypeDirtyTicks, index) > lastTick) {
						isDirtyForQuery = true
						break
					}
				}

				if (isDirtyForQuery) {
					this._chunkView.setChunk(chunkId)
					yield this._chunkView
				}
			}
		}
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
	 * Gets the array of chunk IDs matching this query.
	 * @returns {number[]}
	 */
	getChunks() {
		return this.matchingChunkIds
	}

	registerArchetype(archetype) {
		if (this.archetypeMatches(archetype)) {
			// Ensure we don't add archetypes we already know about.
			if (!this.matchingArchetypeIds.has(archetype)) {
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
					const indices = []

					for (const typeId of this.react) {
						// Perform a binary search to find the index of the component in the archetype's sorted list.
						let low = 0,
							high = count - 1
						while (low <= high) {
							const mid = (low + high) >>> 1
							const midVal = componentIdArray[mid]
							if (midVal === typeId) {
								indices.push(mid) // The index in the dirty tick array is 0-based.
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
