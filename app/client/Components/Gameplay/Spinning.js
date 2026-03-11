/**
 * A component that causes an entity to spin at a constant rate.
 * The actual rotation is applied by the `SpinningSystem`.
 */
export const Spinning = {
	/**
	 * The rate of rotation in radians per second.
	 */
	rate: { type: 'f32', default: 1 },
}