/**
 * A component for testing the 'enum' schema type.
 */
export const enumComponent = {
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
		default: 0,
	},
}
