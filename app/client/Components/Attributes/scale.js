/**
 * A component representing an entity's scale.
 */
export const scale = {
	isTrackable: true,
	/**
	 * The scale factor on the x-axis.
	 */
	x: {
		type: 'f64',
		default: 1,
	},
	/**
	 * The scale factor on the y-axis.
	 */
	y: {
		type: 'f64',
		default: 1,
	},
}
