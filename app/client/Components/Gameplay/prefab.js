/**
 * A component automatically added to entities instantiated from a prefab.
 * It stores the unique numeric ID of the prefab, allowing for efficient
 * runtime type identification (e.g., for generic pooling systems).
 */
export const prefab = {
	/** The unique numeric ID of the prefab, assigned by the PrefabManager. */
	id: { type: 'u32' },
}