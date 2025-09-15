/**
 * A component that manages an entity's set of active items or skills.
 */
export const ActiveSet = {
	/**
	 * A fixed-size array holding the entity IDs of the items in each slot.
	 * An ID of 0 represents an empty slot.
	 */
	slots: {
		type: 'flat_array',
		of: 'entity',
		capacity: 10,
		default: [], // Defaults to all 0s
	},
	/**
	 * The index of the currently active slot.
	 */
	activeSlotIndex: {
		type: 'u8',
		default: 0,
	},
}
