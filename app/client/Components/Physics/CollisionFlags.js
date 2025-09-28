/**
 * A component that manages the directional collision state of an entity using a bitmask.
 */
export const CollisionFlags = {
	/**
	 * A bitmask representing the collision state (e.g., TOP, BOTTOM, LEFT, RIGHT).
	 */
	collisionFlags: {
		type: 'bitmask',
		of: {
			NONE: 0,
			TOP: 1 << 0,
			BOTTOM: 1 << 1,
			LEFT: 1 << 2,
			RIGHT: 1 << 3,
		},
		default: 0, // NONE
	},
}
