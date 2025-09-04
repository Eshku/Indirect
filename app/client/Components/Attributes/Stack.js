export class Stack {
	static schema = {
		current: 'u16',
		size: {
			type: 'u16',
			shared: true,
		},
	}
	/**
	 * @param {object} data
	 * @param {number} [data.current=1] - The current stack size of the item.
	 * @param {number} [data.size=1] - The maximum size for this stack.
	 */
	constructor({ current = 1, size = 1 } = {}) {
		this.current = current
		this.size = size
	}
}
