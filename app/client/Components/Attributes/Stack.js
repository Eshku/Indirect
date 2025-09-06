export class Stack {
	static schema = {
		size: {
			type: 'u16',
			shared: true,
		},
		amount: 'u16',
	}
	/**
	 * @param {object} data
	 * @param {number} [data.size=1] - The maximum size for this stack.
	 * @param {number} [data.amount=1] - The current amount of items in the stack.
	 */
	constructor({ size = 1, amount = 1 } = {}) {
		this.size = size
		this.amount = amount
	}
}
