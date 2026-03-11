/**
 * A component that manages an entity's lifecycle state using a bitmask.
 * This is central to the entity pooling pattern.
 */
export const LifecycleState = {
	/**
	 * A bitmask representing the entity's current state (e.g., ACTIVE, DYING, POOLED).
	 */
	flags: {
		type: 'bitmask',
		of: {
			ACTIVE: 1 << 0,
			DYING: 1 << 1,
			POOLED: 1 << 2,
		},
		default: 1 << 0, // default to active.
	},
}
