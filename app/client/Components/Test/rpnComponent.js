/**
 * component for testing the 'rpn' (Reverse Polish Notation) schema type.
 */
export const rpnComponent = {
	/**
	 * A property that stores RPN formulas.
	 */
	formulas: {
		type: 'rpn',
		streamCapacity: 50,
		instanceCapacity: 5,
		default: [], // Default to no formulas
	},
}
