/**
 * --- ARCHITECTURAL NOTE on Query Design (Unity IJobChunk-Style) ---
 *
 * The design of our query system is inspired by the robust and explicit model used in
 * Unity's Data-Oriented Technology Stack (DOTS). This approach prioritizes API consistency,
 * explicitness, and performance by iterating over chunks of data rather than individual entities.
 *
 * 1.  **A Single, Consistent API**: The `query.iter()` method is the single entry point
 *     for all iteration. It yields each **Chunk** of entities that match the query's
 *     structural definition. A Chunk is a small, cache-friendly block of entities.
 *
 * 2.  **Unified Inner Loop**: Systems iterate over chunks and then over the entities
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
		reactComponents = []
	) {
		this.id = id
		this.queryManager = queryManager
		this.archetypeManager = archetypeManager
		this.iterationLastTick = null

		const withMask = Query._createSimpleMask(withComponents, 'With')
		const reactMask = Query._createSimpleMask(reactComponents, 'React')

		this._requiredMask = withMask | reactMask
		this._excludedMask = Query._createSimpleMask(withoutComponents, 'Without')
		this._anyOfMask = Query._createSimpleMask(anyComponents, 'AnyOf')
		this._reactiveMask = reactMask

		this.isReactiveQuery = this._reactiveMask > 0n
		this.matchingArchetypeIds = []

		if (this.isReactiveQuery) {
			this._reactiveTypeIDsByArchetype = []
			this._reactiveComponentTypeIDs = Query._createComponentTypeIDSet(reactComponents, 'React')
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
			if (this.archetypeManager.archetypeMaxDirtyTicks[archetype] <= this.iterationLastTick) {
				continue
			}
			const chunks = this.archetypeManager.archetypeChunks[archetype]
			for (const chunk of chunks) {
				if (chunk.size > 0) {
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
				for (const typeID of this._reactiveComponentTypeIDs) {
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
