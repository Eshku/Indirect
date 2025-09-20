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
 * Design of our query system is inspired by robust and explicit model used in
 * Unity's Data-Oriented Technology Stack (DOTS). This approach prioritizes API consistency,
 * explicitness, and performance by iterating over chunks of data rather than individual entities.
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

export class Query {
	static _createSimpleMask(componentTypeIDs, categoryName) {
		let mask = 0n
		for (const typeID of componentTypeIDs) {
			if (typeof typeID !== 'number') {
				throw new Error(`Query: ${categoryName} component identifier must be a numeric typeID. Received: ${typeID}`)
			}
			const bitFlag = Schema.componentBitFlags[typeID]
			if (bitFlag === undefined) {
				// This case should theoretically not be hit if typeID is valid.
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
				// This case should theoretically not be hit if typeID is valid.
				throw new Error(`Query: ${categoryName} component identifier must be a numeric typeID. Received: ${typeID}`)
			}
			typeIDs.add(typeID)
		}
		return Object.freeze(typeIDs)
	}

	constructor(
		id,
		queryManager,
		archetypeManager,
		withComponents,
		withoutComponents = [],
		anyComponents = [],
		reactComponents = [],
		readComponents = [], 
		writeComponents = [] 
	) {
		this.id = id
		this.queryManager = queryManager
		this.archetypeManager = archetypeManager
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

		this.read = Query._createComponentTypeIDSet(readComponents, 'Read')
		this.write = Query._createComponentTypeIDSet(writeComponents, 'Write')

		this.isReactiveQuery = this._reactiveMask > 0n
		this.matchingArchetypeIds = []

		if (this.isReactiveQuery) {
			this._reactiveTypeIDsByArchetype = []
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

	//! Switch to non-allocating for or even while loop
	//! After parrallelism implemented.

	*_iterAllArchetypes() {
		for (const archetype of this.matchingArchetypeIds) {
			const chunks = this.archetypeManager.archetypeChunks[archetype]
			for (const chunk of chunks) {
				if (chunk.size > 0) {
					yield chunk
				}
			}
		}
	}

	*_iterChangedArchetypes() {
		for (const archetype of this.matchingArchetypeIds) {
			const chunks = this.archetypeManager.archetypeChunks[archetype]
			for (const chunk of chunks) {
				// yield only changed chunks
				if (chunk.lastDirtyTick > this.iterationLastTick && chunk.size > 0) {
					yield chunk
				}
			}
		}
	}

	hasChanged(chunk, indexInChunk) {
		const tickToProcess = this.iterationLastTick
		const relevantTypeIDs = this._reactiveTypeIDsByArchetype[chunk.archetype]

		if (!relevantTypeIDs) return false

		for (const typeID of relevantTypeIDs) {
			const dirtyTick = chunk.dirtyTicksArrays[typeID][indexInChunk]
			if (dirtyTick > tickToProcess) {
				return true
			}
		}

		return false
	}

	archetypeMatches(archetype) {
		const archetypeMask = this.archetypeManager.archetypeMasks[archetype]

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

	registerArchetype(archetype) {
		if (this.archetypeMatches(archetype)) {
			if (this.isReactiveQuery) {
				const relevantTypeIDs = []
				for (const typeID of this.react) {
					if (this.archetypeManager.hasComponentType(archetype, typeID)) {
						relevantTypeIDs.push(typeID)
					}
				}
				this._reactiveTypeIDsByArchetype[archetype] = relevantTypeIDs
			}
			this.matchingArchetypeIds.push(archetype)
		}
	}

	unregisterArchetype(deletedArchetype) {
		const index = this.matchingArchetypeIds.indexOf(deletedArchetype)
		if (index > -1) {
			this.matchingArchetypeIds.splice(index, 1)
			if (this.isReactiveQuery) {
				this._reactiveTypeIDsByArchetype[deletedArchetype] = undefined
			}
		}
	}

	destroy() {
		this.queryManager.destroyQuery(this)
	}
}
