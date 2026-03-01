/**
 * A component that holds the current state of the cursor as a bitmask.
 * This allows other systems to react to what the cursor is hovering over.
 */
export const CursorState = {
	flags: {
		type: 'bitmask',
		of: {
			DEFAULT: 1 << 0,
			NEUTRAL: 1 << 1,
			INTERACTABLE: 1 << 2,
			ENEMY: 1 << 3,
			FRIENDLY: 1 << 4,
			INVALID_ACTION: 1 << 5,
		},
		default: 1 << 0, // Start in the default state
	},
}