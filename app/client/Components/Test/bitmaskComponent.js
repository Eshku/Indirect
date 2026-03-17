/**
 *  component for testing the 'bitmask' schema type.
 */
export const bitmaskComponent = {
	/**
	 * A bitmask property for storing multiple boolean flags.
	 */
	flags: {
		type: 'bitmask',
		of: {
			FLAG_A: 1 << 0,
			FLAG_B: 1 << 1,
			FLAG_C: 1 << 2,
			FLAG_D: 1 << 3,
		},
		default: [],
	},
}
