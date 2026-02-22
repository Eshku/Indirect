/**
 * Represents a declarative query for entities with a specific set of components.
 *
 * ---
 * ### Dev Note: Mutable Queries and Parallelism
 *
 * A "mutable" query is one that can change its `with`, `without`, or other filters at runtime.
 * While engine's `QueryManager` supports creating unique, non-cached mutable queries,
 * they pose a significant challenge for a parallel job scheduler.
 *
 * **Problem:** A scheduler relies on a static analysis of a system's data dependencies
 * (its queries) at start of a frame to build a dependency graph and safely schedule jobs
 * in parallel. If a query's filters change mid-frame, initial analysis becomes invalid,
 * and scheduler could incorrectly run two systems in parallel that now conflict, leading
to a race condition.
 *
 * **"Quarantine" Approach (Simple & Safe):**
 * Simplest and safest way to handle this is for scheduler to "quarantine" any system
 * that uses a mutable query, forcing it to run serially on main thread.
 *
 * **"Dynamic Re-Analysis" Approach (Advanced & Complex):**
 * A more advanced (and much more complex) scheduler could handle this more gracefully. When a
 * mutable query's filters change, it could signal scheduler. Scheduler would then,
 * for *next* frame, re-analyze that system's dependencies and attempt to re-insert it
 * into parallel job graph. While this unlocks more powerful queries, it introduces 
 * overhead of re-scheduling. This is an inefficient pattern if a query changes its
 * definition frequently, but it enables more powerful and dynamic system logic. This is a
 * potential future optimization, not a current implementation.
 * ---
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

import * as Schema from '../../ECS/ComponentManager/ComponentSchema.js'
import { ChunkView } from './ChunkView.js'
import { entityStore } from '../../ECS/EntityManager/EntityManager.js'

const INITIAL_CHUNK_CAPACITY = 256

export class Query {
	static _createSimpleMask(componentTypeIDs, categoryName) {
		let mask = 0n
		for (const typeID of componentTypeIDs) {
			if (typeof typeID !== 'number') {
				throw new Error(`Query: ${categoryName} component identifier must be a numeric typeID. Received: ${typeID}`)
			}
			const bitFlag = Schema.componentBitFlags[typeID]
			if (bitFlag === undefined) {
				throw new Error(`Query: ${categoryName} component with typeID "${typeID}" does not have a valid bitflag.`)
			}
			mask |= bitFlag
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

		this.with = Query._createComponentTypeIDSet(withComponents, 'With')
		this.without = Query._createComponentTypeIDSet(withoutComponents, 'Without')
		this.any = Query._createComponentTypeIDSet(anyComponents, 'AnyOf')
		this.react = Query._createComponentTypeIDSet(reactComponents, 'React')

		const withMask = Query._createSimpleMask(withComponents, 'With')
		const reactMask = Query._createSimpleMask(reactComponents, 'React')

		this._requiredMask = withMask | reactMask
		this._excludedMask = Query._createSimpleMask(withoutComponents, 'Without')
		this._anyOfMask = Query._createSimpleMask(anyComponents, 'AnyOf')
		this._reactiveMask = reactMask

		this.isReactiveQuery = this._reactiveMask > 0n

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

	registerArchetype(archetype) {
		if (this.archetypeMatches(archetype)) {
			// Ensure we don't add archetypes we already know about.
			if (!this.matchingArchetypeIds.has(archetype)) {
				const chunks = entityStore.archetypeChunks[archetype]
				for (const chunkId of chunks) {
					this.matchingChunkIds.push(chunkId)
				}
				this.matchingArchetypeIds.add(archetype)

				// Notify the QueryManager so it can add this query to its archetype-based index.
				this.queryManager._addQueryToArchetypeIndex(this, archetype)

				if (this.isReactiveQuery) {
					// Pre-compute the indices into the chunkArchetypeDirtyTicks array for this archetype.
					const componentIdArray = entityStore.archetypeComponentTypeIDArrays[archetype]
					const count = componentIdArray[0]
					const indices = []

					for (const typeId of this.react) {
						// Perform a binary search to find the index of the component in the archetype's sorted list.
						let low = 1
						let high = count
						while (low <= high) {
							const mid = (low + high) >>> 1
							const midVal = componentIdArray[mid]
							if (midVal === typeId) {
								indices.push(mid - 1) // The index in the dirty tick array is 0-based.
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
		const archetypeMask = entityStore.archetypeMasks[archetype]

		if ((archetypeMask & this._requiredMask) !== this._requiredMask) {
			return false
		}

		if ((archetypeMask & this._excludedMask) !== 0n) {
			return false
		}

		if (this._anyOfMask !== 0n && (archetypeMask & this._anyOfMask) === 0n) {
			return false
		}

		return true
	}

	unregisterArchetype(deletedArchetype) {
		if (this.matchingArchetypeIds.has(deletedArchetype)) {
			// Remove the chunks associated with the deleted archetype
			const chunksToRemove = new Set(entityStore.archetypeChunks[deletedArchetype] || [])
			this.matchingChunkIds = this.matchingChunkIds.filter(chunkId => !chunksToRemove.has(chunkId))

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
