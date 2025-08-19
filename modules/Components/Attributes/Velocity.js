/**
 * A "hot" component representing an entity's velocity in 2D world space.
 * This component dictates how an entity's position changes over time.
 * Its data is stored in high-performance TypedArrays (SoA).
 */
export class Velocity {
	static schema = {
		x: { type: 'f64' },
		y: { type: 'f64' },
	}
	/**
	 * @param {object} [data={}] - The initial data for the velocity.
	 * @param {number} [data.x=0] - The velocity on the x-axis in units per second.
	 * @param {number} [data.y=0] - The velocity on the y-axis in units per second.
	 */
	constructor({ x = 0, y = 0 } = {}) {
		this.x = x
		this.y = y
	}
}
