/**
 * Stores the unique numeric ID for the prefab that an entity was created from.
 * This is the "hot" data used at runtime for fast type-checking and lookups.
 * The mapping from a human-readable string name to this numeric ID is handled
 * by the `PrefabManager`.
 */
export const Prefab = {
	/**
	 * The numeric ID of the prefab.
	 */
	id: {
		type: 'u32',
		shared: true, // This property is now part of the shared data group.
	},
}
