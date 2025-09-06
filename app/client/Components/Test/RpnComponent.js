/**
 * @fileoverview Tests the 'rpn' (Reverse Polish Notation) schema type for formulas.
 */
export class RpnComponent {
	static schema = {
		formulas: { type: 'rpn', streamCapacity: 50, instanceCapacity: 5 },
	}

	constructor({ formulas = [] } = {}) {
		this.formulas = formulas
	}
}
