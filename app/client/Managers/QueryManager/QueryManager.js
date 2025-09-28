const { Query } = await import(`${PATH_MANAGERS}/QueryManager/Query.js`)


/**
 * Manages creation and lifecycle of queries for ECS.
 * This manager implements a robust caching and reference-counting system for queries.
 * When a query is requested, a canonical key is generated from its configuration.
 * If a query with same key already exists, cached instance is returned and its
 * reference count is incremented. This is a major performance optimization that avoids
 * redundant query objects and archetype matching. A query is only truly destroyed when
 * its reference count drops to zero.
 *
 * Systems can opt-out of caching by passing `mutable: true` in query options,
 * which guarantees a unique, non-shared query instance.
 *
 * ---
 * ### Developer Note: Mutable Queries and Parallelism
 *
 * `mutable: true` flag provides powerful flexibility but introduces challenges for a
 * future parallel job scheduler. A scheduler relies on static analysis of a system's data
 * dependencies (read/write access) to safely run systems in parallel. A query that can
 * that can change its component filters at runtime makes this static analysis difficult.
 *
 * #### "Quarantine" Approach (Simple & Safe)
 * A simple scheduler would need to "quarantine" such systems, running them serially
 * on main thread to prevent race conditions. This is safest initial approach.
 *
 * #### "Dynamic Re-Analysis" Approach (Advanced & Powerful)
 * A more advanced scheduler could handle mutable queries without permanent quarantining.
 * When a mutable query's filters change, it could notify scheduler. scheduler
 * would then, for next frame, re-analyze only that system's dependencies and attempt
 * to re-insert it into parallel job graph. While significantly more complex to
 * implement, this approach unlocks maximum performance by allowing even dynamic systems
 * to be parallelized when their dependencies don't conflict. This is long-term vision
 * for handling mutable queries.
 */


//! Query mutability going to be decided later on.
export class QueryManager {
	constructor() {
		this.queryCache = new Map()
		this.queriesById = []
		this.nextQueryId = 0
	}

	async init(ecs) {
		// This manager is now owned by ECS, so it gets its dependencies from there.
		this.componentManager = ecs.componentManager
		this.entityManager = ecs.entityManager
	}

	_generateQueryKey(options) {
		const {
			with: withComponents = [],
			without: withoutComponents = [],
			any: anyComponents = [],
			react: reactComponents = [],
			read: readComponents = [],
			write: writeComponents = [],
			constants: constantsDef = {},
		} = options
		
		// Sort component IDs to ensure the key is canonical.
		const withIdsString = [...withComponents].sort((a, b) => a - b).join(',')
		const withoutIdsString = [...withoutComponents].sort((a, b) => a - b).join(',')
		const anyIdsString = [...anyComponents].sort((a, b) => a - b).join(',')
		const reactIdsString = [...reactComponents].sort((a, b) => a - b).join(',')
		const readIdsString = [...readComponents].sort((a, b) => a - b).join(',')
		const writeIdsString = [...writeComponents].sort((a, b) => a - b).join(',')

		// Sort constant keys for canonical key generation.
		const constantKeys = Object.keys(constantsDef).sort()
		const constantsString = constantKeys.map(propName => `${propName}:${constantsDef[propName]}`).join(',')

		return `w:${withIdsString}|wo:${withoutIdsString}|a:${anyIdsString}|r:${reactIdsString}|rd:${readIdsString}|wr:${writeIdsString}|c:${constantsString}`
	}

	/**
	 * Retrieves a new or cached query based on provided configuration.
	 * @param {object} options - query configuration object.
	 * @param {number[]} [options.with=[]] - Component type IDs that must be present.
	 * @param {number[]} [options.without=[]] - Component type IDs that must NOT be present.
	 * @param {number[]} [options.any=[]] - Component type IDs where at least one must be present.
	 * @param {number[]} [options.react=[]] - Component type IDs that, if changed, will make entity match query.
	 * @param {number[]} [options.read=[]] - Component type IDs that system reads from for dependency tracking.
	 * @param {number[]} [options.write=[]] - Component type IDs that system writes to.
	 * @param {boolean} [options.mutable=false] - If true, guarantees a unique, non-cached query instance.
	 *
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
	getQuery({
		with: withComponents = [],
		without = [],
		any = [],
		react = [],
		read = [],
		write = [],
		constants = {},
		mutable = false,
	}) {
		try {
			const options = { with: withComponents, without, any, react, read, write, constants, mutable };

			const queryKey = mutable ? `mutable:${this.nextQueryId}` : this._generateQueryKey(options)

			const cachedQuery = this.queryCache.get(queryKey)
			if (cachedQuery) {
				cachedQuery.refCount++
				return cachedQuery
			}

			const queryId = this.nextQueryId++;

			const constantsRequest = this._parseConstants(options.constants)

			const newQuery = new Query(
				queryId,
				this,
				this.entityManager, 
				options.with, 
				options.without,
				options.any,
				options.react,
				options.read,
				options.write,
				constantsRequest
			)

			newQuery.refCount = 1
			newQuery.cacheKey = queryKey;
			this.queryCache.set(queryKey, newQuery)
			this.queriesById[queryId] = newQuery;

			for (const archetypeId of this.entityManager.archetypeLookup.values()) {
				newQuery.registerArchetype(archetypeId)
			}

			return newQuery
		} catch (error) {
			console.error(`QueryManager: Error creating query:`, error)
			return undefined
		}
	}

	getQueryById(id) {
		return this.queriesById[id];
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

	registerArchetype(newArchetypeId) {
		for (const query of this.queryCache.values()) {
			query.registerArchetype(newArchetypeId)
		}
	}

	unregisterArchetype(deletedArchetypeId) {
		for (const query of this.queryCache.values()) {
			query.unregisterArchetype(deletedArchetypeId)
		}
	}

	releaseQuery(queryToRelease) {
		if (!queryToRelease) return

		queryToRelease.refCount--

		if (queryToRelease.refCount <= 0) {
			this.queryCache.delete(queryToRelease.cacheKey)
			this.queriesById[queryToRelease.id] = undefined;
		}
	}
}
