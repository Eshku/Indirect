/**
 * Defines a simple Axis-Aligned Bounding Box (AABB) for an entity.
 * Used for custom, geometry-based collision checks (e.g., with platforms),
 * separate from the main physics engine.
 */
export class Collider {
	static schema = {
		width: 'f32',
		height: 'f32',
	}
	/**
	 * @param {object} data
	 * @param {number} [data.width=32] - The width of the collider.
	 * @param {number} [data.height=64] - The height of the collider. Used to determine the feet position for vertical collisions.
	 */
	constructor({ width = 32, height = 64 } = {}) {
		this.width = width
		this.height = height
	}
}