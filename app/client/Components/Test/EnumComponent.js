/**
 * A component for testing the 'enum' schema type.
 */
export const EnumComponent = {
	/**
	 * An enum property representing a state.
	 */
	state: {
		type: 'enum',
		of: {
			IDLE: 0,
			RUNNING: 1,
			JUMPING: 2,
		},
		default: 'IDLE',
	},
}
