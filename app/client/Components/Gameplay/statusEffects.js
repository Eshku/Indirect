/**
 * Manages gameplay-related status effects for an entity, such as being stunned,
 * poisoned, or silenced. This component uses a bitmask for efficient checking
 * of multiple, non-exclusive states.
 */
export const statusEffects = {
	/**
	 * A bitmask representing the active status effects on the entity.
	 */
	flags: {
		type: 'bitmask',
		of: {
			NONE: 0,
			STUNNED: 1 << 0,
			PARALYZED: 1 << 1,
			ROOTED: 1 << 2,
			SILENCED: 1 << 3,
			POISONED: 1 << 4,
			BLEEDING: 1 << 5,
			BURNING: 1 << 6,
		},
		default: 0, // NONE
	},
}
