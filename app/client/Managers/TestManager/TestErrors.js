/**
 * A custom error class for assertion failures.
 * This allows the TestManager to catch assertion errors specifically,
 * distinguishing them from other runtime errors in the test code.
 */
export class AssertionError extends Error {
	constructor(message, expected, actual) {
		super(message)
		this.name = 'AssertionError'
		this.expected = expected
		this.actual = actual
	}
}