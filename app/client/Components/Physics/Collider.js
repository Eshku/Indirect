/**
 * Defines a simple Axis-Aligned Bounding Box (AABB) for an entity,
 * used for custom, geometry-based collision checks.
 */
export const Collider = {
	/**
	 * The width of the collider.
	 */
	width: {
		type: 'f32',
		default: 32,
	},
	/**
	 * The height of the collider.
	 */
	height: {
		type: 'f32',
		default: 64,
	},
}
