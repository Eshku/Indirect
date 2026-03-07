const { Query } = await import(`${PATH_MANAGERS}/QueryManager/Query.js`)

const { entityStore } = await import(`${PATH_MANAGERS}/EntityManager/EntityManager.js`)


//! Query mutability going to be decided later on.
export class QueryManager {
	constructor() {
		this.queryCache = new Map()
		this.queriesById = []
		this.nextQueryId = 0

		// A new, simple cache to store the generated string keys themselves.
		// This avoids re-calculating the key string on every single getQuery call.
		this.keyCache = new Map()

		// --- Indices for the "pull" model of archetype registration ---
		this.queriesWith = new Map() // Map<typeId, Set<Query>>
		this.queriesWithout = new Map() // Map<typeId, Set<Query>>
		this.queriesAny = new Map() // Map<typeId, Set<Query>>
		// Index for queries that only have `without` clauses (no `with`, `any`, or `react`).
		this.queriesWithOnlyExclusions = new Set()

		// --- Index for the "pull" model for chunk/archetype events ---
		this.queriesByArchetype = new Map() // Map<archetypeId, Set<Query>>
	}

	async init(ecs) {
		// This manager is now owned by ECS, so it gets its dependencies from there.
		this.componentManager = ecs.componentManager
		this.entityManager = ecs.entityManager
	}

	/**
	 * Gets a canonical, cached string key for a query configuration.
	 * This is core optimization. Instead of generating a new string on every call,
	 * it uses a simple nested map to find or create key ONCE. All subsequent
	 * calls for same configuration will be near-instant cache hits with zero allocation.
	 *
	 * This is a one-time cost during system initialization, not a runtime cost.
	 * @param {object} options query options.
	 * @returns {string} cached, canonical string key.
	 * @private
	 */
	_getCachedQueryKey(options) {
		// --- Fast Path ---
		// The first level of caching uses the options object reference itself as the key.
		// This is extremely fast and covers the common case where the same query object literal is reused.
		if (this.keyCache.has(options)) {
			return this.keyCache.get(options)
		}

		// --- Slow Path ---
		// If the object reference is different, we fall back to generating a canonical string key.
		// This handles cases where different systems define identical but separate query objects.
		const key = this._generateQueryKey(options)

		// Cache the generated key against the options object so the next call with this
		// same object reference hits the fast path.
		this.keyCache.set(options, key)

		return key
	}

	/**
	 * Generates a canonical, sorted string key from a query options object.
	 * This is the "slow path" for query lookup, only run when the options object
	 * reference isn't found in the first-level cache.
	 * @param {object} options
	 * @returns {string}
	 * @private
	 */
	_generateQueryKey(options) {
		const { // Use different names to avoid shadowing
			with: withInput = [],
			without: withoutInput = [],
			any: anyInput = [],
			react: reactInput = [],
			constants: constantsDef = {},
		} = options

		// --- DX Improvement: Normalize single values to arrays ---
		// This must be done here because the key generation needs to iterate.
		const normalize = comps => (comps ? (Array.isArray(comps) ? comps : [comps]) : [])
		const withComponents = normalize(withInput)
		const withoutComponents = normalize(withoutInput)
		const anyComponents = normalize(anyInput)
		const reactComponents = normalize(reactInput)

		// Sort component IDs to ensure the key is canonical.
		const withIdsString = [...withComponents].sort((a, b) => a - b).join(',')
		const withoutIdsString = [...withoutComponents].sort((a, b) => a - b).join(',')
		const anyIdsString = [...anyComponents].sort((a, b) => a - b).join(',')
		const reactIdsString = [...reactComponents].sort((a, b) => a - b).join(',')

		// Sort constant keys for canonical key generation.
		const constantKeys = Object.keys(constantsDef).sort()
		const constantsString = constantKeys.map(propName => `${propName}:${constantsDef[propName]}`).join(',')

		return `w:${withIdsString}|wo:${withoutIdsString}|a:${anyIdsString}|r:${reactIdsString}|c:${constantsString}`
	}

	/**
	 * Retrieves a new or cached query based on provided configuration.
	 * @param {object} options - query configuration object.
	 * @param {number[]} [options.with=[]] - Component type IDs that must be present.
	 * @param {number[]} [options.without=[]] - Component type IDs that must NOT be present.
	 * @param {number[]} [options.any=[]] - Component type IDs where at least one must be present.
	 * @param {number[]} [options.react=[]] - Component type IDs that, if changed, will make entity match query.
	 *
	 * ! Constants are going to be either deprecated (define your own) or redone to be thread safe.
	 * @example
	 * // In a system's constructor or init method:
	 * const { componentManager } = this.ecs;
	 * const { CollisionFlags } = componentManager.getTypeIDs();
	 *
	 * // Best Practice: Cache constants during initialization for high performance.
	 * this.COLLISION_CONSTANTS = componentManager.getConstantsForProperty(CollisionFlags, 'flags');
	 *
	 * this.query = this.ecs.queryManager.getQuery({
	 *     with: [CollisionFlags]
	 * });
	 * @returns {Query} A new or cached Query instance.
	 */
	getQuery(options) {
		try {
			// Use the cached key generation to avoid per-frame string allocation.
			const queryKey = this._getCachedQueryKey(options)

			const cachedQuery = this.queryCache.get(queryKey)
			if (cachedQuery) {
				cachedQuery.refCount++
				return cachedQuery
			}

			const queryId = this.nextQueryId++

			const constantsRequest = this._parseConstants(options.constants)

			const newQuery = new Query(
				queryId,
				this,
				options.with,
				options.without,
				options.any,
				options.react,
				constantsRequest,
			)

			newQuery.refCount = 1
			newQuery.cacheKey = queryKey
			this.queryCache.set(queryKey, newQuery)
			this.queriesById[queryId] = newQuery

			this._registerQueryInIndices(newQuery)

			for (const archetypeId of entityStore.archetypeLookup.values()) {
				newQuery.registerArchetype(archetypeId)
			}

			return newQuery
		} catch (error) {
			console.error(`QueryManager: Error creating query:`, error)
			return undefined
		}
	}

	getQueryById(id) {
		return this.queriesById[id]
	}

	/**
	 * Parses 'constants' option from a query definition into a plan for populating chunk.constants.
	 * @param {object} constantsDef - constants definition from query options.
	 * @returns {Array<{localName: string, componentTypeID: number, propertyName: string}>}
	 * @private
	 */
	_parseConstants(constantsDef) {
		const parsedRequest = []
		if (constantsDef) {
			for (const propertyName in constantsDef) {
				const componentTypeID = constantsDef[propertyName]
				if (componentTypeID !== undefined) {
					parsedRequest.push({ localName: propertyName, componentTypeID, propertyName })
				}
			}
		}
		return parsedRequest
	}

	_registerQueryInIndices(query) {
		const register = (map, typeId) => {
			if (!map.has(typeId)) {
				map.set(typeId, new Set())
			}
			map.get(typeId).add(query)
		}

		// Reactive components are also 'with' components for matching purposes
		const allPositiveRequirements = [...query.with, ...query.react]

		for (const typeId of allPositiveRequirements) {
			register(this.queriesWith, typeId)
		}
		for (const typeId of query.without) {
			register(this.queriesWithout, typeId)
		}
		for (const typeId of query.any) {
			register(this.queriesAny, typeId)
		}

		if (allPositiveRequirements.length === 0 && query.any.size === 0) {
			this.queriesWithOnlyExclusions.add(query)
		}
	}

	_unregisterQueryFromIndices(query) {
		const unregister = (map, typeId) => {
			if (map.has(typeId)) {
				map.get(typeId).delete(query)
				if (map.get(typeId).size === 0) {
					map.delete(typeId)
				}
			}
		}

		const allPositiveRequirements = [...query.with, ...query.react]

		for (const typeId of allPositiveRequirements) {
			unregister(this.queriesWith, typeId)
		}
		for (const typeId of query.without) {
			unregister(this.queriesWithout, typeId)
		}
		for (const typeId of query.any) {
			unregister(this.queriesAny, typeId)
		}

		if (allPositiveRequirements.length === 0 && query.any.size === 0) {
			this.queriesWithOnlyExclusions.delete(query)
		}
	}

	_addQueryToArchetypeIndex(query, archetypeId) {
		if (!this.queriesByArchetype.has(archetypeId)) {
			this.queriesByArchetype.set(archetypeId, new Set())
		}
		this.queriesByArchetype.get(archetypeId).add(query)
	}

	_removeQueryFromArchetypeIndex(query, archetypeId) {
		const queries = this.queriesByArchetype.get(archetypeId)
		if (queries) {
			queries.delete(query)
			if (queries.size === 0) {
				this.queriesByArchetype.delete(archetypeId)
			}
		}
	}

	registerArchetype(newArchetypeId) {
		const candidateQueries = new Set()
		const archetypeComponentIDs = this.entityManager.getComponentTypeIDsForArchetype(newArchetypeId)

		if (!archetypeComponentIDs) return

		// 1. Gather candidates that have a `with` or `any` requirement matching a component in the new archetype.
		for (const typeId of archetypeComponentIDs) {
			this.queriesWith.get(typeId)?.forEach(q => candidateQueries.add(q))
			this.queriesAny.get(typeId)?.forEach(q => candidateQueries.add(q))
		}

		// 2. Add all queries that only have `without` clauses, as they could match any new archetype.
		this.queriesWithOnlyExclusions.forEach(q => candidateQueries.add(q))

		// 3. Run the final, precise `archetypeMatches` check on the much smaller candidate set.
		for (const query of candidateQueries) {
			query.registerArchetype(newArchetypeId)
		}
	}

	/**
	 * Notifies all relevant queries that a new chunk has been added to an existing archetype.
	 * @param {number} archetypeId The ID of the archetype that received a new chunk.
	 * @param {number} newChunkId The ID of the newly created chunk.
	 */
	registerChunk(archetypeId, newChunkId) {
		const matchingQueries = this.queriesByArchetype.get(archetypeId)
		if (matchingQueries) {
			for (const query of matchingQueries) {
				query.registerChunk(archetypeId, newChunkId)
			}
		}
	}

	/**
	 * Notifies all relevant queries that a chunk has been removed from an archetype.
	 * @param {number} archetypeId The archetype ID.
	 * @param {number} chunkId The ID of the chunk that was removed/recycled.
	 */
	unregisterChunk(archetypeId, chunkId) {
		const matchingQueries = this.queriesByArchetype.get(archetypeId)
		if (matchingQueries) {
			for (const query of matchingQueries) {
				query.unregisterChunk(archetypeId, chunkId)
			}
		}
	}

	unregisterArchetype(deletedArchetypeId) {
		const matchingQueries = this.queriesByArchetype.get(deletedArchetypeId)
		if (matchingQueries) {
			// We must clone the set before iterating, because `query.unregisterArchetype`
			// will call `_removeQueryFromArchetypeIndex`, which modifies the set we are iterating over.
			for (const query of [...matchingQueries]) {
				query.unregisterArchetype(deletedArchetypeId)
			}
		}
	}

	/**
	 * Clears all matching archetype data from every cached query.
	 * This is called by the EntityManager during a full world reset.
	 */
	unregisterAllArchetypes() {
		this.queriesByArchetype.clear()
		for (const query of this.queryCache.values()) {
			query.clearArchetypes()
		}
	}

	destroyQuery(queryToRelease) {
		if (!queryToRelease) return

		queryToRelease.refCount--

		if (queryToRelease.refCount <= 0) {
			this.queryCache.delete(queryToRelease.cacheKey)
			this.queriesById[queryToRelease.id] = undefined
			this._unregisterQueryFromIndices(queryToRelease)
			// Also remove it from the archetype-based index.
			for (const archetypeId of queryToRelease.matchingArchetypeIds) {
				this._removeQueryFromArchetypeIndex(queryToRelease, archetypeId)
			}
		}
	}
}

export const queryManager = new QueryManager()
