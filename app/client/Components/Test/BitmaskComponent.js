/**
 *  component for testing the 'bitmask' schema type.
 */
export const BitmaskComponent = {
	/**
	 * A bitmask property for storing multiple boolean flags.
	 */
	flags: {
		type: 'bitmask',
		of: ['FLAG_A', 'FLAG_B', 'FLAG_C', 'FLAG_D'],
		default: [],
	},
}
