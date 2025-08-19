export class TestManager {
	constructor() {
		this.tests = new Map() // Store test results by suite
	}

	async init() {
		this.registerTests('Examples', [exampleTest, exampleFailingTest])
	}

	registerTests(suiteName, tests) {
		if (!this.tests.has(suiteName)) {
			this.tests.set(suiteName, [])
		}
		this.tests.get(suiteName).push(...tests)
	}

	async runTests(suiteName) {
		const tests = this.tests.get(suiteName)
		if (!tests || tests.length === 0) {
			console.error(`Test suite "${suiteName}" not found.`)
			return
		}

		let passedCount = 0
		let totalCount = 0

		console.log(`\nRunning tests for suite: ${suiteName}`)
		console.log('------------------------------------')

		for (let i = 0; i < tests.length; i++) {
			const test = tests[i]
			let testResult
			try {
				testResult = await test()
			} catch (error) {
				testResult = {
					testName: test.name || 'Unnamed Test',
					expected: 'No Error',
					actual: `Error: ${error.message}`,
				}
			}
			const result = this.log(testResult.testName, testResult.expected, testResult.actual)
			totalCount++
			if (result.passed) {
				passedCount++
			}
		}

		this.outputSummary(suiteName, passedCount, totalCount)
	}

	async runAllTests() {
		const suiteNames = Array.from(this.tests.keys())
		for (let i = 0; i < suiteNames.length; i++) {
			const suiteName = suiteNames[i]
			await this.runTests(suiteName)
		}
	}

	log(testName, expected, actual) {
		const stringify = value => {
			if (value === undefined) {
				return 'undefined'
			}
			if (value === null) {
				return 'null'
			}
			try {
				return JSON.stringify(value)
			} catch (error) {
				console.error('Error stringifying value:', error)
				return 'Unstringifiable value'
			}
		}

		const expectedStr = stringify(expected)
		const actualStr = stringify(actual)
		const passed = expectedStr === actualStr
		const color = passed ? '\x1b[32m' : '\x1b[31m' // Green or Red
		const reset = '\x1b[0m'
		const testNameColor = '\x1b[36m' // Blue for test name

		console.log(`${testNameColor}Test: ${testName}${reset}`)
		console.log(`  Expected: ${expectedStr}`)
		console.log(`  Actual:   ${actualStr}`)
		console.log(`  ${color}Result: ${passed ? 'Passed' : 'Failed'}${reset}`)
		return { passed, testName, expected: expectedStr, actual: actualStr }
	}

	outputSummary(suiteName, passedCount, totalCount) {
		const summaryColor = passedCount === totalCount ? '\x1b[32m' : '\x1b[31m' // Green if all passed, red otherwise
		const summaryReset = '\x1b[0m'
		const bold = '\x1b[1m'
		const large = '\x1b[3m'

		console.log('------------------------------------')
		console.log(
			`${summaryColor}${bold}${large}Summary for ${suiteName}: ${passedCount} / ${totalCount} tests passed${summaryReset}`
		)
		console.log('------------------------------------\n')
	}
}

export const testManager = new TestManager()

// Example test case
function exampleTest() {
	const add = (a, b) => a + b
	const testName = 'Example: Addition Test'
	const expected = 5
	const actual = add(2, 3)
	return {
		testName,
		expected,
		actual,
	}
}

function exampleFailingTest() {
	const multiply = (a, b) => a * b
	const testName = 'Example: Multiplication Test (Failing)'
	const expected = 10
	const actual = multiply(2, 3)

	return {
		testName,
		expected,
		actual,
	}
}
