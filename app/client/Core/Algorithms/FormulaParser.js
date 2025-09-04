/**
 * @fileoverview Implements a formula parser using the Shunting-yard algorithm.
 * This utility compiles human-readable mathematical formulas into an efficient
 * Reverse Polish Notation (RPN) array of opcodes and operands for fast runtime evaluation.
 */

/**
 * Compiles a formula string into a Reverse Polish Notation (RPN) array.
 *
 * @param {string} formula - The formula string to parse (e.g., "BASE + (STR * 1.5)").
 * @param {object} config - The configuration for the parser.
 * @param {object} config.opcodes - A map of operation names to their numeric opcodes (e.g., { PUSH_LITERAL: -1 }).
 * @param {object} config.variables - A map of variable names (e.g., 'STR', 'BASE') to their RPN sequence (e.g., `[OP.PUSH_STAT, 0]`). Case-insensitive.
 * @param {object} config.operators - A map of operator symbols to their precedence and opcode (e.g., `'+': { precedence: 1, opcode: -4 }`).
 * @returns {number[]} The compiled RPN sequence as an array of numbers.
 */
export function compileFormulaToRPN(formula, { opcodes, variables, operators }) {
	if (!formula) return []

	// 1. Tokenize the input string. This regex captures numbers, words (variables), and operators.
	const tokens = formula.match(/\d+(\.\d+)?|\w+|[+\-*/()]/g)
	if (!tokens) return []

	const outputQueue = []
	const operatorStack = []

	// 2. Process tokens using the Shunting-yard algorithm
	for (const token of tokens) {
		const upperToken = token.toUpperCase()
		if (!isNaN(parseFloat(token))) {
			outputQueue.push(opcodes.PUSH_LITERAL, parseFloat(token))
		} else if (variables[upperToken]) {
			outputQueue.push(...variables[upperToken])
		} else if (operators[token]) {
			const opInfo = operators[token]
			while (
				operatorStack.length > 0 &&
				operatorStack[operatorStack.length - 1] !== '(' &&
				operators[operatorStack[operatorStack.length - 1]]?.precedence >= opInfo.precedence
			) {
				outputQueue.push(operators[operatorStack.pop()].opcode)
			}
			operatorStack.push(token)
		} else if (token === '(') {
			operatorStack.push(token)
		} else if (token === ')') {
			while (operatorStack.length > 0 && operatorStack[operatorStack.length - 1] !== '(') {
				outputQueue.push(operators[operatorStack.pop()].opcode)
			}
			if (operatorStack.length === 0) {
				// Mismatched parentheses
				console.error(`FormulaParser: Mismatched parentheses in formula: "${formula}"`)
				return []
			}
			operatorStack.pop() // Discard the '('
		} else {
			console.warn(`FormulaParser: Unknown token "${token}" in formula: "${formula}"`)
		}
	}

	// 3. Pop remaining operators from the stack to the output queue
	while (operatorStack.length > 0) {
		const op = operatorStack.pop()
		if (op === '(') {
			console.error(`FormulaParser: Mismatched parentheses in formula: "${formula}"`)
			return []
		}
		outputQueue.push(operators[op].opcode)
	}

	return outputQueue
}