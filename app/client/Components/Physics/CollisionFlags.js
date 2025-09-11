/**
 * A component that manages the directional collision state of an entity using a bitmask.
 */
export const CollisionFlags = {
	/**
	 * A bitmask representing the collision state (e.g., TOP, BOTTOM, LEFT, RIGHT).
	 */
	collisionFlags: {
		type: 'bitmask',
		of: ['NONE', 'TOP', 'BOTTOM', 'LEFT', 'RIGHT'],
		default: ['NONE'],
	},
}
