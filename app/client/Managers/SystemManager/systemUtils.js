const { Query } = await import(`@managers/QueryManager/Query.js`);

/**
 * Iterates over a system instance's properties and releases any queries it owns.
 * This is a crucial cleanup step to prevent memory leaks from orphaned queries
 * during development (e.g., via HMR) or when systems are dynamically removed.
 * @param {object} systemInstance The system instance to clean up.
 */
export function releaseSystemQueries(systemInstance) {
	if (!systemInstance) return;

	for (const key in systemInstance) {
		// Check if the property is an own property to avoid iterating over the prototype chain.
		if (Object.prototype.hasOwnProperty.call(systemInstance, key)) {
			const prop = systemInstance[key];
			if (prop instanceof Query) {
				// The QueryManager reference-counts queries, so we release our "hold" on it.
				prop.queryManager.destroyQuery(prop);
			}
		}
	}
}