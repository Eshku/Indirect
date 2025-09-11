/**
 * Holds the state for an entity's jumping ability.
 */
export const Jump = {
	/**
	 * The initial upward velocity for a jump in pixels/second.
	 */
	jumpForce: {
		type: 'f32',
		default: 450,
	},
	/**
	 * True if a jump action is currently intended.
	 */
	wantsToJump: {
		type: 'boolean',
		default: false,
	},
}
