/**
 * A component representing an entity's scale.
 */
export const scale = {
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
	/**
	 * The game tick when this component was last modified.
	 * Used for fine-grained reactive change detection.
	 */
	dirtyTick: { type: 'u32', default: 0 },
}
