const { Query } = await import(`${PATH_MANAGERS}/QueryManager/Query.js`)
const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)

/**
 * @fileoverview Manages the creation and lifecycle of queries for the ECS.
 * This manager implements a robust caching and reference-counting system for queries.
 * When a query is requested, a canonical key is generated from its configuration.
 * If a query with the same key already exists, the cached instance is returned and its
 * reference count is incremented. This is a major performance optimization that avoids
 * redundant query objects and archetype matching. A query is only truly destroyed when
 * its reference count drops to zero.
 *
 * Systems can opt-out of caching by passing `mutable: true` in the query options,
 * which guarantees a unique, non-shared query instance.
 *
 * ---
 * ### Developer Note: Mutable Queries and Parallelism
 *
 * The `mutable: true` flag provides powerful flexibility but introduces challenges for a
 * future parallel job scheduler. A scheduler relies on static analysis of a system's data
 * dependencies (read/write access) to safely run systems in parallel. A query that can
 * that can change its component filters at runtime makes this static analysis difficult.
 *
 * #### The "Quarantine" Approach (Simple & Safe)
 * A simple scheduler would need to "quarantine" such systems, running them serially
 * on the main thread to prevent race conditions. This is the safest initial approach.
 *
 * #### The "Dynamic Re-Analysis" Approach (Advanced & Powerful)
 * A more advanced scheduler could handle mutable queries without permanent quarantining.
 * When a mutable query's filters change, it could notify the scheduler. The scheduler
 * would then, for the next frame, re-analyze only that system's dependencies and attempt
 * to re-insert it into the parallel job graph. While significantly more complex to
 * implement, this approach unlocks maximum performance by allowing even dynamic systems
 * to be parallelized when their dependencies don't conflict. This is the long-term vision
 * for handling mutable queries.
 */
class QueryManager {
	constructor() {
		this.queryCache = new Map() // Maps canonical key to a Query object
		this.nextMutableQueryId = 0 // For generating unique keys for mutable queries
	}

	async init() {
		this.componentManager = theManager.getManager('ComponentManager')
		this.archetypeManager = theManager.getManager('ArchetypeManager')
	}

	_generateQueryKey(options) {
		// If the query is marked as mutable, give it a guaranteed unique key
		// so it is never shared, but still benefits from the ref-counting lifecycle.
		if (options.mutable) {
			return `mutable:${this.nextMutableQueryId++}`
		}

		const {
			with: withComponents = [],
			without: withoutComponents = [],
			any: anyComponents = [],
			react: reactComponents = [],
			constants: constantsDef = {},
		} = options

		const getComponentId = componentClass => this.componentManager.getComponentTypeID(componentClass)

		// Sort component IDs to ensure the key is canonical.
		const withIdsString = withComponents.map(getComponentId).sort().join(',')
		const withoutIdsString = withoutComponents.map(getComponentId).sort().join(',')
		const anyIdsString = anyComponents.map(getComponentId).sort().join(',')
		const reactIdsString = reactComponents.map(getComponentId).sort().join(',')

		// Sort constant keys for canonical key generation.
		const constantKeys = Object.keys(constantsDef).sort()
		const constantsString = constantKeys.map(propName => `${propName}:${getComponentId(constantsDef[propName])}`).join(',')

		return `w:${withIdsString}|wo:${withoutIdsString}|a:${anyIdsString}|r:${reactIdsString}|c:${constantsString}`
	}

	/**
	 * Retrieves a new or cached query based on the provided configuration.
	 * @param {object} options - The query configuration object.
	 * @param {Function[]} [options.with=[]] - Components that must be present.
	 * @param {Function[]} [options.without=[]] - Components that must NOT be present.
	 * @param {Function[]} [options.any=[]] - Components where at least one must be present.
	 * @param {Function[]} [options.react=[]] - Components that, if changed, will make the entity match the query.
	 * @param {Object.<string, Function>} [options.constants={}] - A map to declaratively request
	 *   enum/bitmask constants for optimal cache-locality. The key is the property name from the
	 *   component's schema, and the value is the component class itself. The resolved constant
	 *   maps will be available on `chunk.constants` in the system loop.
	 *
	 * @example
	 * // In CollisionFlags.js: static schema = { collisionFlags: { type: 'bitmask', ... } }
	 *
	 * // In MovementSystem, declare the constant:
	 * this.query = queryManager.getQuery({
	 *     with: [CollisionFlags],
	 *     constants: {
	 *         collisionFlags: CollisionFlags
	 *     }
	 * });
	 *
	 * // In the update loop:
	 * for (const chunk of this.query.iter()) {
	 *     const { collisionFlags } = chunk.constants; // { LEFT: 1, RIGHT: 2, ... }
	 *     // ... use collisionFlags for checks
	 * }
	 *
	 * // --- FUTURE NOTE on Low-Level Systems ---
	 * // For maximum performance and to eliminate class imports, a future version of this API
	 * // may support using componentTypeIDs directly, e.g., `{ collisionFlags: 12 }`.
	 * // This is not yet implemented.
	 * @param {boolean} [options.mutable=false] - If true, guarantees a unique, non-cached query instance.
	 * @returns {Query} A new or cached Query instance.
	 */
	getQuery({ with: withComponents = [], without = [], any = [], react = [], constants = {}, mutable = false }) {
		try {
			const options = { with: withComponents, without, any, react, constants, mutable }
			const queryKey = this._generateQueryKey(options)

			const cachedQuery = this.queryCache.get(queryKey)
			if (cachedQuery) {
				cachedQuery.refCount++
				return cachedQuery
			}

			const constantsRequest = this._parseConstants(options.constants)

			const newQuery = new Query(
				queryKey, // Use the key as the ID
				this,
				this.componentManager,
				this.archetypeManager,
				options.with,
				options.without,
				options.any,
				options.react,
				constantsRequest
			)

			newQuery.refCount = 1
			this.queryCache.set(queryKey, newQuery)

			for (const archetypeId of this.archetypeManager.archetypeLookup.values()) {
				newQuery.registerArchetype(archetypeId)
			}

			return newQuery
		} catch (error) {
			console.error(`QueryManager: Error creating query:`, error)
			return undefined
		}
	}

	/**
	 * Parses the 'constants' option from a query definition into a plan for populating chunk.constants.
	 * @param {object} constantsDef - The constants definition from the query options.
	 * @returns {Array<{localName: string, componentTypeID: number, propertyName: string}>}
	 * @private
	 */
	_parseConstants(constantsDef) {
		const parsedRequest = []
		if (constantsDef) {
			for (const propertyName in constantsDef) {
				const ComponentClass = constantsDef[propertyName]
				const componentTypeID = this.componentManager.getComponentTypeID(ComponentClass)
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
			this.queryCache.delete(queryToRelease.id)
		}
	}
}

export const queryManager = new QueryManager()