/**
 * Defines the reset behavior for a pooled entity in a data-driven way.
 * When an entity with this component is transitioned to the POOLED state,
 * the pooling system will use this data to clean it up for reuse.
 */

//! that won't do.
export const Poolable = {
	/**
	 * An array of component names to **remove** from the entity upon reset.
	 * The prefab processor will convert these to numeric IDs.
	 */
	remove: { type: 'flat_array', of: 'component', capacity: 16 },

	/**
	 * An array of component names to **reset to their default schema values**.
	 * The prefab processor will convert these to numeric IDs.
	 */
	reset: { type: 'flat_array', of: 'component', capacity: 16 },
}