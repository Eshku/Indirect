/**
 * A component for testing the 'enum' schema type.
 */
export const EnumComponent = {
	/**
	 * An enum property representing a state.
	 */
	state: {
		type: 'enum',
		of: ['IDLE', 'RUNNING', 'JUMPING'],
		default: 'IDLE',
	},
}
