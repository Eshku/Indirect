/**
 * A component to store the verification status of an entity in the ChurnTestSystem.
 */
export const Verification = {
	/**
	 * The status of the verification check.
	 * 0: unchecked, 1: ok, -1: fail, 2: fail_logged
	 */
	status: {
		type: 'i8',
		default: 0,
	},
}