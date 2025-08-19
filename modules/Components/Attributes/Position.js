/**
 * A "hot" component representing an entity's position in 2D world space.
 * This is a core component for anything that exists physically in the game world.
 * Its data is stored in high-performance TypedArrays (SoA).
 */
export class Position {
	static schema = {
		x: { type: 'f64' },
		y: { type: 'f64' },
	}
	/**
	 * @param {object} [data={}] - The initial data for the position.
	 * @param {number} [data.x=0] - The x-coordinate in world space.
	 * @param {number} [data.y=0] - The y-coordinate in world space.
	 */
	constructor({ x = 0, y = 0 } = {}) {
		this.x = x
		this.y = y
	}
}
