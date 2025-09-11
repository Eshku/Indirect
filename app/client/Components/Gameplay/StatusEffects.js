/**
 * Manages gameplay-related status effects for an entity, such as being stunned,
 * poisoned, or silenced. This component uses a bitmask for efficient checking
 * of multiple, non-exclusive states.
 */
export const StatusEffects = {
	/**
	 * A bitmask representing the active status effects on the entity.
	 */
	flags: {
		type: 'bitmask',
		of: ['NONE', 'STUNNED', 'PARALYZED', 'ROOTED', 'SILENCED', 'POISONED', 'BLEEDING', 'BURNING'],
		default: ['NONE'],
	},
}
