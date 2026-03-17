/**
 * Defines an Axis-Aligned Bounding Box (AABB) collider for an entity.
 */
export const boxCollider = {
	/**
	 * The width of the box.
	 */
	width: {
		type: 'f32',
		default: 32,
	},
	/**
	 * The height of the box.
	 */
	height: {
		type: 'f32',
		default: 32,
	},
}