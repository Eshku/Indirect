const { Query } = await import(`${PATH_MANAGERS}/QueryManager/Query.js`)
const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)

/**
 * --- ARCHITECTURAL NOTE on Query Design ---
 *
 * This QueryManager follows a "mutable by default" and "uncached" philosophy.
 * This design choice prioritizes a simple, powerful API and developer control over
 * memory micro-optimization.
 *
 * 1.  **Maximum Control & Simplicity**: Every call to `getQuery()` returns a new,
 *     unique, and mutable Query instance. This means each system "owns" its queries
 *     and can modify them at any time without affecting other systems. There is no
 *     need for developers to manage different types of queries (mutable vs. immutable)
 *     or use different methods to create them.
 *
 * 2.  **The Trade-Off**: The primary trade-off for this simplicity is a slightly
 *     higher memory footprint, as queries are not shared (cached) between systems
 *     that might ask for the same component combination. Given that queries are
 *     generally created once per system during initialization, this overhead is
 *     considered a worthwhile price for a cleaner, more predictable API.
 *
 * 3.  **Lifecycle Management**: Because each query is a unique instance, the system
 *     that creates it is responsible for its lifecycle. The system must call
 *     `query.destroy()` when it is no longer needed to prevent memory leaks.
 */
/**
 * Manages the creation and lifecycle of queries.
 * Queries are used by systems to efficiently iterate over entities with a specific set of components.
 * In this architecture, all queries are mutable and non-cached. Each call to `getQuery`
 * returns a new, unique Query instance.
 * @property {Query[]} _activeQueries - A list of all active queries. Used for updating them when archetypes change.
 */
class QueryManager {
	constructor() {
		this._activeQueries = []
	}

	/**
	 * Initializes the manager and sets up dependencies.
	 */
	async init() {
		this.componentManager = theManager.getManager('ComponentManager')
		this.archetypeManager = theManager.getManager('ArchetypeManager')
	}

	/**
	 * Generates a human-readable string key for a query's properties.
	 * This is intended for debugging and logging purposes only.
	 * @param {object} options - The query options object.
	 * @param {Function[]} [options.with=[]] - 'with' component classes.
	 * @param {Function[]} [options.without=[]] - 'without' component classes.
	 * @param {Function[]} [options.any=[]] - 'any' component classes.
	 * @param {Function[]} [options.react=[]] - 'react' component classes.
	 * @returns {string | null} A human-readable key string, or null if any class is not registered.
	 */
	toDebugKey({ with: required = [], without = [], any = [], react = [] }) {
		const getNames = classes =>
			classes
				.map(c => c.name)
				.sort()
				.join(',')

		const requiredKey = getNames(required)
		const excludedKey = getNames(without)
		const anyOfKey = getNames(any)
		const reactiveKey = getNames(react)

		return `R[${requiredKey}]_N[${excludedKey}]_A[${anyOfKey}]_C[${reactiveKey}]`
	}

	/**
	 * Creates a new, unique Query instance for the given set of component classes.
	 * Every query returned by this method is mutable and independent. The system that creates a query
	 * is responsible for calling `query.destroy()` when it is no longer needed to prevent memory leaks.
	 * @param {object} options - The query definition object.
	 * @param {Function[]} [options.with=[]] - An array of component classes that an entity MUST have.
	 * @param {Function[]} [options.without=[]] - An array of component classes that an entity must NOT have.
	 * @param {Function[]} [options.any=[]] - An array where an entity must have AT LEAST ONE of these component classes.
	 * @param {Function[]} [options.react=[]] - An array of component classes to monitor for changes.
	 * @returns {Query | undefined} The Query instance, or undefined on error.
	 */
	getQuery({ with: required = [], without = [], any = [], react = [] }) {
		try {
			// In this model, all queries are mutable by default.
			const newQuery = new Query(required, without, any, react)

			this._activeQueries.push(newQuery)

			// Populate the new query with all existing archetypes.
			for (const archetypeId of this.archetypeManager.archetypeLookup.values()) {
				newQuery.checkAndAddArchetype(archetypeId)
			}
			return newQuery
		} catch (error) {
			console.error(`QueryManager: Error creating query:`, error)
			return undefined
		}
	}

	/**
	 * Registers a new archetype with all active queries.
	 * Each query will check if it matches the new archetype and add it to its list if it does.
	 * This is called by the ArchetypeManager when an archetype is first created.
	 * @param {number} newArchetypeId - The internal ID of the newly created archetype.
	 */
	registerArchetype(newArchetypeId) {
		for (const query of this._activeQueries) {
			query.checkAndAddArchetype(newArchetypeId)
		}
	}

	/**
	 * Unregisters a deleted archetype from all active queries.
	 * This ensures that queries no longer attempt to iterate over archetypes that are empty and have been removed.
	 * This is called by the ArchetypeManager when an archetype is deleted.
	 * @param {number} deletedArchetypeId - The internal ID of the archetype that was deleted.
	 */
	unregisterArchetype(deletedArchetypeId) {
		for (const query of this._activeQueries) {
			query.removeArchetype(deletedArchetypeId)
		}
	}

	/**
	 * Destroys a query instance, removing it from the active list so it no longer receives updates.
	 * This is intended to be called from `query.destroy()` for mutable queries.
	 * @param {Query} queryToDestroy - The query instance to destroy.
	 * @private
	 */
	destroyQuery(queryToDestroy) {
		const index = this._activeQueries.indexOf(queryToDestroy)
		if (index > -1) {
			this._activeQueries.splice(index, 1)
		}
	}
}

export const queryManager = new QueryManager()
