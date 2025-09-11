/**
 * A component that marks an entity as being in an owner's active set of items/skills.
 */
export const InActiveSet = {
	/**
	 * The slot index (0-9) where this item/skill is located in the owner's ActiveSet.
	 */
	slot: {
		type: 'u8',
		default: 0,
	},
}
