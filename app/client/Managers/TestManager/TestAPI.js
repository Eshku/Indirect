import { testManager } from './TestManager.js'
import { AssertionError } from './TestErrors.js'

/**
 * Provides a BDD-style (Behavior-Driven Development) testing API
 * for defining test suites and individual test cases. This module exports
 * `describe`, `it`, and `expect` functions, similar to popular testing frameworks.
 */

/**
 * The main assertion function. It captures the actual value and returns a
 * "matcher" object that contains the assertion logic.
 * @param {*} actual - The actual value produced by the code under test.
 * @returns {object} A matcher object with methods like .toBe() and .toEqual().
 */
export function expect(actual) {
	const createMatcher = (inverted = false) => ({
		/**
		 * Checks for strict equality (===).
		 * @param {*} expected - The expected value.
		 * @throws {AssertionError} If the assertion fails.
		 * @example
		 * expect(1).toBe(1); // Passes
		 * expect('hello').toBe('world'); // Fails
		 * expect(result).toBe(true, 'The operation should succeed'); // Fails with custom message
		 */
		toBe(expected, customMessage) {
			const passed = actual === expected
			if (passed === inverted) {
				const baseMessage = `Expected ${actual} ${inverted ? 'not ' : ''}to be ${expected}`
				const finalMessage = customMessage ? `${baseMessage} (${customMessage})` : baseMessage
				throw new AssertionError(finalMessage, expected, actual)
			}
		},
		/**
		 * Checks for deep equality by comparing JSON stringified versions.
		 * Useful for objects and arrays.
		 * @throws {AssertionError} If the assertion fails.
		 * @example
		 * expect({ a: 1 }).toEqual({ a: 1 }); // Passes
		 * expect([1, 2]).toEqual([2, 1]); // Fails (order matters for JSON.stringify)
		 * @param {*} expected - The expected object/array.
		 */
		toEqual(expected, customMessage) {
			// Add a replacer to handle BigInts, which JSON.stringify does not support by default.
			const replacer = (key, value) => (typeof value === 'bigint' ? value.toString() : value)

			const actualStr = JSON.stringify(actual, replacer)
			const expectedStr = JSON.stringify(expected, replacer)

			const passed = actualStr === expectedStr
			if (passed === inverted) {
				const baseMessage = `Expected ${actualStr} ${inverted ? 'not ' : ''}to equal ${expectedStr}`
				const finalMessage = customMessage ? `${baseMessage} (${customMessage})` : baseMessage
				throw new AssertionError(finalMessage, expected, actual)
			}
		},
		/**
		 * Checks if an object has a specified property.
		 * @param {string} propertyKey - The name of the property to check for.
		 * @throws {AssertionError} If the assertion fails.
		 * @example
		 * expect({ a: 1 }).toHaveProperty('a'); // Passes
		 * expect({ a: 1 }).not.toHaveProperty('b'); // Passes
		 */
		toHaveProperty(propertyKey, customMessage) {
			if (typeof actual !== 'object' || actual === null) {
				throw new AssertionError(
					`Expected value to be an object but got ${actual === null ? 'null' : typeof actual}`,
					'object',
					typeof actual
				)
			}
			const passed = propertyKey in actual
			if (passed === inverted) {
				const baseMessage = `Expected object ${inverted ? 'not ' : ''}to have property "${propertyKey}"`
				const finalMessage = customMessage ? `${baseMessage} (${customMessage})` : baseMessage
				throw new AssertionError(finalMessage, `An object ${inverted ? 'without' : 'with'} property "${propertyKey}"`, actual)
			}
		},
		/**
		 * Checks if a value is not undefined.
		 * @throws {AssertionError} If the assertion fails.
		 * @example
		 * expect({}).toBeDefined(); // Passes
		 * expect(undefined).not.toBeDefined(); // Passes
		 */
		toBeDefined(customMessage) {
			const passed = actual !== undefined
			if (passed === inverted) {
				const message = customMessage ? `Expected value ${inverted ? 'not ' : ''}to be defined (${customMessage})` : `Expected value ${inverted ? 'not ' : ''}to be defined`
				const expectedValue = inverted ? undefined : 'a defined value'
				throw new AssertionError(message, expectedValue, actual)
			}
		},
		/**
		 * Checks if a value is undefined.
		 * @throws {AssertionError} If the assertion fails.
		 * @example
		 * expect(undefined).toBeUndefined(); // Passes
		 * expect({}).not.toBeUndefined(); // Passes
		 */
		toBeUndefined(customMessage) {
			const passed = actual === undefined
			if (passed === inverted) {
				const message = customMessage ? `Expected value ${inverted ? 'not ' : ''}to be undefined (${customMessage})` : `Expected value ${inverted ? 'not ' : ''}to be undefined`
				const expectedValue = inverted ? 'a defined value' : undefined
				throw new AssertionError(message, expectedValue, actual)
			}
		},
		/**
		 * Checks if an array or string contains a specific element or substring.
		 * @param {*} expected - The element or substring to look for.
		 * @throws {AssertionError} If the assertion fails.
		 * @example
		 * expect([1, 2, 3]).toContain(2); // Passes
		 * expect('hello world').toContain('world'); // Passes
		 */
		toContain(expected, customMessage) {
			if (!Array.isArray(actual) && typeof actual !== 'string') {
				throw new AssertionError(
					`Expected value to be an array or a string but got ${typeof actual}`,
					'array or string',
					typeof actual
				)
			}
			const passed = actual.includes(expected)
			if (passed === inverted) {
				const baseMessage = `Expected ${JSON.stringify(actual)} ${inverted ? 'not ' : ''}to contain ${JSON.stringify(expected)}`
				const finalMessage = customMessage ? `${baseMessage} (${customMessage})` : baseMessage
				throw new AssertionError(finalMessage, `An array/string ${inverted ? 'not ' : ''}containing ${JSON.stringify(expected)}`, actual)
			}
		},
		/**
		 * Checks if a value is greater than an expected value.
		 * @param {number | bigint} expected - The value to compare against.
		 * @throws {AssertionError} If the assertion fails.
		 * @example
		 * expect(11).toBeGreaterThan(10); // Passes
		 * expect(10).toBeGreaterThan(10); // Fails
		 */
		toBeGreaterThan(expected, customMessage) {
			const passed = actual > expected
			if (passed === inverted) {
				const baseMessage = `Expected ${actual} ${inverted ? 'not ' : ''}to be greater than ${expected}`
				const finalMessage = customMessage ? `${baseMessage} (${customMessage})` : baseMessage
				throw new AssertionError(finalMessage, `a value > ${expected}`, actual)
			}
		},
		/**
		 * Checks the type of a value using `typeof`.
		 * @param {string} expected - The expected type string (e.g., 'string', 'number', 'bigint').
		 * @throws {AssertionError} If the assertion fails.
		 */
		toBeTypeOf(expected, customMessage) {
			const actualType = typeof actual
			const passed = actualType === expected
			if (passed === inverted) {
				const baseMessage = `Expected type ${inverted ? 'not ' : ''}to be ${expected} but got ${actualType}`
				const finalMessage = customMessage ? `${baseMessage} (${customMessage})` : baseMessage
				throw new AssertionError(finalMessage, expected, actualType)
			}
		},
		/**
		 * Checks if a value is greater than or equal to an expected value.
		 * @param {number | bigint} expected - The value to compare against.
		 * @throws {AssertionError} If the assertion fails.
		 * @example
		 * expect(10).toBeGreaterThanOrEqual(10); // Passes
		 * expect(11).toBeGreaterThanOrEqual(10); // Passes
		 * expect(9).toBeGreaterThanOrEqual(10); // Fails
		 */
		toBeGreaterThanOrEqual(expected, customMessage) {
			const passed = actual >= expected
			if (passed === inverted) {
				const baseMessage = `Expected ${actual} ${inverted ? 'not ' : ''}to be greater than or equal to ${expected}`
				const finalMessage = customMessage ? `${baseMessage} (${customMessage})` : baseMessage
				throw new AssertionError(finalMessage, `a value >= ${expected}`, actual)
			}
		},
		/**
		 * Checks if a value is an instance of a constructor.
		 * @param {Function} constructor - The constructor to check against.
		 * @throws {AssertionError} If the assertion fails.
		 * @example
		 * expect(new Date()).toBeInstanceOf(Date); // Passes
		 * expect([]).toBeInstanceOf(Array); // Passes
		 */
		toBeInstanceOf(constructor, customMessage) {
			const passed = actual instanceof constructor
			if (passed === inverted) {
				// Provide more informative names in the error message.
				const actualName = actual?.constructor?.name || typeof actual
				const expectedName = constructor?.name || 'Unknown Constructor'
				const baseMessage = `Expected value ${inverted ? 'not ' : ''}to be an instance of ${expectedName}, but was instance of ${actualName}`
				const finalMessage = customMessage ? `${baseMessage} (${customMessage})` : baseMessage
				throw new AssertionError(finalMessage, `instance of ${expectedName}`, `instance of ${actualName}`)
			}
		},
	})

	return {
		...createMatcher(false),
		/**
		 * Inverts the following assertion.
		 * @example
		 * expect(1).not.toBe(2); // Passes
		 * expect('test').not.toEqual('test'); // Fails
		 * expect([1]).not.toEqual([2]); // Passes
		 */
		not: createMatcher(true),
	}
}

/**
 * Defines a test suite. All `it` calls inside the callback will be grouped under this suite.
 * @param {string} suiteName - The name of the test suite.
 * @param {Function} callback - A function containing the tests for this suite.
 * @example
 * describe('My Feature Tests', () => {
 *   // ... it() blocks here ...
 * });
 */
export function describe(suiteName, callback) {
	testManager.setCurrentSuite(suiteName)
	callback()
	testManager.clearCurrentSuite()
}

/**
 * Defines an individual test case.
 * @param {string} testName - The name of the test.
 * @param {Function} testFn - The function that executes the test logic and assertions.
 * @example
 * it('should do something correctly', () => {
 *   expect(someValue).toBe(expectedValue);
 * });
 */
export function it(testName, testFn) {
	testManager.registerTest(testName, testFn)
}