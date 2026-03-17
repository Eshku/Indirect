/**
 * Defines an Oriented Bounding Box (OBB) collider for an entity.
 * Unlike a BoxCollider (AABB), an OBB's orientation is determined by the
 * entity's `Rotation` component, allowing for precise collision with rotated objects.
 */
export const orientedBoxCollider = {
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