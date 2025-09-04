// d:\Code\Games\Indirect\Engine\app\client\Managers\TestManager\TestManager.js
import { AssertionError } from './TestErrors.js'

/**
 * @fileoverview Manages the registration, execution, and reporting of test suites.
 * This manager works in conjunction with `TestAPI.js` to provide a BDD-style testing framework.
 * It collects test functions defined via `describe` and `it`, executes them, and logs the results
 * to the console, including detailed failure information.
 */
export class TestManager {
	constructor() {
		/**
		 * Stores test functions, organized by suite name.
		 * @type {Map<string, Array<{name: string, fn: Function}>>}
		 */
		this.suites = new Map()
		/**
		 * The name of the currently active test suite, set by `describe`.
		 * @type {string | null}
		 */
		this.currentSuiteName = null

		// --- Global State for runAllTests ---
		/** @type {number} */
		this.totalSuitesPassed = 0
		/** @type {number} */
		this.totalTestsPassed = 0
		/** @type {number} */
		this.totalTestsRun = 0
		/** @type {Array<{suite: string, test: string}>} */
		this.failedTests = []
	}

	async init() {
		// The example tests are now written in the BDD style
		// and would typically be in their own test file.
		// For demonstration, they are implicitly registered here.
	}

	/**
	 * Sets the current test suite context. Called by `describe` from `TestAPI.js`.
	 * @param {string} suiteName - The name of the suite being defined.
	 */
	setCurrentSuite(suiteName) {
		this.currentSuiteName = suiteName
		if (!this.suites.has(suiteName)) {
			this.suites.set(suiteName, [])
		}
	}

	/**
	 * Clears the current test suite context. Called by `describe` from `TestAPI.js`.
	 */
	clearCurrentSuite() {
		this.currentSuiteName = null
	}

	/**
	 * Registers an individual test case under the current suite. Called by `it` from `TestAPI.js`.
	 * @param {string} testName - The name of the individual test.
	 * @param {Function} testFn - The function containing the test logic and assertions.
	 */
	registerTest(testName, testFn) {
		if (!this.currentSuiteName) {
			console.error(`Test "${testName}" was defined outside of a "describe" block.`)
			return
		}
		const suite = this.suites.get(this.currentSuiteName)
		// Store as an object containing the name and the function to run, for later execution.
		suite.push({ name: testName, fn: testFn })
	}

	/**
	 * Executes all tests within a specified suite.
	 * @param {string} suiteName - The name of the test suite to run.
	 * @returns {Promise<{passed: boolean, passedCount: number, totalCount: number}>} A promise that resolves with the suite's results.
	 */
	async runTests(suiteName) {
		const tests = this.suites.get(suiteName)
		if (!tests || tests.length === 0) {
			console.error(`Test suite "${suiteName}" not found.`)
			return { passed: false, passedCount: 0, totalCount: 0 } // Return a default result for consistency
		}

		let passedCount = 0
		let totalCount = 0
		const suiteStartTime = performance.now()

		console.log(`\nRunning tests for suite: ${suiteName}`)
		console.log('------------------------------------')

		for (let i = 0; i < tests.length; i++) {
			const { name, fn } = tests[i]
			const testStartTime = performance.now()
			let passed = false
			let errorInfo = null
			try {
				await fn() // Execute the test function
				passed = true
			} catch (error) {
				passed = false
				if (error instanceof AssertionError) {
					// A controlled test failure from an `expect` call.
					errorInfo = { message: error.message, expected: error.expected, actual: error.actual }
				} else {
					// An unexpected runtime error in the test code.
					errorInfo = { message: `Caught unexpected error: ${error.stack}` }
				}
			}
			const testDuration = performance.now() - testStartTime
			totalCount++
			if (passed) {
				passedCount++
			}
			this.logTestResult(name, passed, errorInfo, testDuration)
			if (!passed) {
				this.failedTests.push({ suite: suiteName, test: name })
			}
		}

		const suiteDuration = performance.now() - suiteStartTime
		this.outputSuiteSummary(suiteName, passedCount, totalCount, suiteDuration)
		return { passed: passedCount === totalCount, passedCount, totalCount }
	}

	/**
	 * Executes all registered test suites.
	 * @returns {Promise<void>} A promise that resolves when all test suites have completed.
	 */
	async runAllTests() {
		// Reset global counters for a fresh run
		this.totalSuitesPassed = 0
		this.totalTestsPassed = 0
		this.totalTestsRun = 0
		this.failedTests = []
		const allTestsStartTime = performance.now()

		const suiteNames = Array.from(this.suites.keys())
		for (let i = 0; i < suiteNames.length; i++) {
			const suiteName = suiteNames[i]
			const result = await this.runTests(suiteName)
			if (result.passed) {
				this.totalSuitesPassed++
			}
			this.totalTestsPassed += result.passedCount
			this.totalTestsRun += result.totalCount
		}

		const allTestsDuration = performance.now() - allTestsStartTime

		// Only show the grand total summary if there's more than one suite
		if (suiteNames.length > 1) {
			this.outputGrandTotalSummary(suiteNames.length, allTestsDuration)
		}
	}

	/**
	 * Outputs a final summary for the entire test run.
	 * @param {number} totalSuitesRun - The total number of suites executed.
	 * @param {number} duration - The total time for all suites to run.
	 */
	outputGrandTotalSummary(totalSuitesRun, duration) {
		const allTestsPassed = this.totalTestsPassed === this.totalTestsRun

		const green = '\x1b[32m'
		const red = '\x1b[31m'
		const grey = '\x1b[90m'
		const bold = '\x1b[1m'
		const reset = '\x1b[0m'

		if (allTestsPassed) {
			const durationInSeconds = (duration / 1000).toFixed(2)
			const successMessage = `✔ All tests (${this.totalTestsRun} / ${this.totalTestsRun}) passed in ${durationInSeconds}s`
			console.log(`\n${green}${bold}${successMessage}${reset}\n`)
		} else {
			const allSuitesPassed = this.totalSuitesPassed === totalSuitesRun
			const suitesIcon = allSuitesPassed ? `${green}✔` : `${red}✖`
			const suitesSummary = `Suites: ${suitesIcon}${reset} ${this.totalSuitesPassed} / ${totalSuitesRun}`
			const testsIcon = `${red}✖`
			const testsSummary = `Tests:  ${testsIcon}${reset} ${this.totalTestsPassed} / ${this.totalTestsRun}`
			const timeSummary = `Time:   ${duration.toFixed(2)}ms`

			console.log(`\n${bold}Test Run Complete:${reset}`)
			console.log(`  ${suitesSummary}`)
			console.log(`  ${testsSummary}`)
			console.log(`  ${timeSummary}\n`)
			console.log(`${bold}${red}Failed Tests:${reset}`)
			this.failedTests.forEach(({ suite, test }) => {
				console.log(`  ${red}✖ ${grey}${suite} > ${test}${reset}`)
			})
			console.log('') // Add a blank line for spacing
		}
	}

	/**
	 * Logs the result of a single test case to the console.
	 * @param {string} testName - The name of the test.
	 * @param {boolean} passed - Whether the test passed.
	 * @param {object|null} errorInfo - Details about the failure.
	 * @param {number} duration - The time the test took to run in milliseconds.
	 */
	logTestResult(testName, passed, errorInfo, duration) {
		const green = '\x1b[32m'
		const red = '\x1b[31m'
		const blue = '\x1b[36m' // Original test name color
		const grey = '\x1b[90m'
		const reset = '\x1b[0m'

		// Always display the duration in a neutral grey color.
		const durationText = `${grey}(${duration.toFixed(0)}ms)${reset}`

		if (passed) {
			console.log(`  ${green}✔${reset} ${blue}${testName}${reset} ${durationText}`)
		} else {
			// Failing tests also show their duration.
			console.log(`  ${red}✖${reset} ${blue}${testName}${reset} ${durationText}`)
			if (errorInfo) {
				const stringify = value => JSON.stringify(value, null, 2)

				// Use original color scheme for details.
				if (errorInfo.expected !== undefined && errorInfo.actual !== undefined) {
					console.log(`    Expected: ${green}${stringify(errorInfo.expected)}${reset}`)
					console.log(`    Actual:   ${red}${stringify(errorInfo.actual)}${reset}`)
				}
				if (errorInfo.message) {
					// Indent error messages for readability.
					const messageLines = errorInfo.message.split('\n')
					messageLines.forEach(line => console.log(`    ${red}${line}${reset}`))
				}
			}
		}
	}

	/**
	 * Outputs a summary for a completed test suite.
	 * @param {string} suiteName - The name of the suite.
	 * @param {number} passedCount - The number of tests that passed.
	 * @param {number} totalCount - The total number of tests in the suite.
	 * @param {number} duration - The total time the suite took to run.
	 */
	outputSuiteSummary(suiteName, passedCount, totalCount, duration) {
		const summaryColor = passedCount === totalCount ? '\x1b[32m' : '\x1b[31m' // Green if all passed, red otherwise
		const summaryReset = '\x1b[0m'
		const bold = '\x1b[1m'
		const large = '\x1b[3m'

		console.log('------------------------------------')
		const durationText = `in ${duration.toFixed(2)}ms`
		const summaryText = `Summary for ${suiteName}: ${passedCount} / ${totalCount} tests passed`
		console.log(`${summaryColor}${bold}${large}${summaryText}${summaryReset} ${large}(${durationText})${summaryReset}`)
		console.log('------------------------------------\n')
	}
}

export const testManager = new TestManager()
