import { testManager } from './TestManager.js'
import { AssertionError } from './TestErrors.js'

/**
 * @fileoverview Provides a BDD-style (Behavior-Driven Development) testing API
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
		 */
		toBe(expected) {
			const passed = actual === expected
			if (passed === inverted) {
				throw new AssertionError(`Expected ${actual} ${inverted ? 'not ' : ''}to be ${expected}`, expected, actual)
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
		toEqual(expected) {
			const actualStr = JSON.stringify(actual)
			const expectedStr = JSON.stringify(expected)
			const passed = actualStr === expectedStr
			if (passed === inverted) {
				throw new AssertionError(
					`Expected ${actualStr} ${inverted ? 'not ' : ''}to equal ${expectedStr}`,
					expected,
					actual
				)
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