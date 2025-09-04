export class Stack {
	constructor() {
		/**
		 * The internal array that stores the stack items.
		 * @private
		 * @type {Array<*>}
		 */
		this._items = []
	}

	/**
	 * Adds an item to the top of the stack.
	 * @param {*} item - The item to add.
	 */
	push(item) {
		this._items.push(item)
	}

	/**
	 * Removes and returns the item from the top of the stack.
	 * @returns {*|undefined} The item at the top of the stack, or undefined if the stack is empty.
	 */
	pop() {
		return this._items.pop()
	}

	/**
	 * Returns the item at the top of the stack without removing it.
	 * @returns {*|undefined} The item at the top of the stack, or undefined if the stack is empty.
	 */
	peek() {
		if (this.isEmpty()) {
			return undefined
		}
		return this._items[this._items.length - 1]
	}

	/**
	 * Checks if the stack is empty.
	 * @returns {boolean} True if the stack is empty, false otherwise.
	 */
	isEmpty() {
		return this._items.length === 0
	}

	/**
	 * Returns the number of items in the stack.
	 * @returns {number} The number of items in the stack.
	 */
	get size() {
		return this._items.length
	}

	/**
	 * Alias for size.
	 * @returns {number} The number of items in the stack.
	 */
	get length() {
		return this.size
	}

	/**
	 * Removes all items from the stack.
	 */
	clear() {
		this._items.length = 0
	}

	/**
	 * Returns an array representation of the stack.
	 * The order of items in the array will be from bottom to top of the stack.
	 * @returns {Array<*>} A new array containing the items of the stack.
	 */
	toArray() {
		return [...this._items] // Creates a shallow copy
	}

	/**
	 * Creates a shallow copy of the stack.
	 * The items themselves are not cloned.
	 * @returns {Stack} A new Stack instance with the same items.
	 */
	clone() {
		const newStack = new Stack()
		newStack._items = [...this._items]
		return newStack
	}
}
