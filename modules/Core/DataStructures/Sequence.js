//faster iteration compared to linked list, faster random access, slower inserts.

export class Sequence {
	constructor() {
		/**
		 * The internal array that stores the sequence items.
		 * @type {Array}
		 */

		this.items = []
	}

	/**
	 * Inserts a new item at the end of the sequence.
	 *
	 * @param {*} item - The item to insert.
	 * @returns {number} - The index where the last item was inserted.
	 */
	insert(...items) {
		this.items.push(...items)
		return this.items.length - 1
	}

	/**
	 * Inserts a new item at the beginning of the sequence.
	 *
	 * @param {*} item - The item to insert at the beginning.
	 * @returns {number} - The index where the item was inserted (0).
	 */
	insertFirst(...items) {
		this.items.unshift(...items)
		return 0
	}

	/**
	 * Inserts a new item at the end of the sequence.
	 *
	 * @param {*} item - The item to insert at the end.
	 * @returns {number} - The index where the last item was inserted.
	 */
	insertLast(...items) {
		return this.insert(...items)
	}

	/**
	 * Inserts a new item immediately before the item at the specified index.
	 *
	 * @param {...*} items - Items to insert. The last argument must be the index.
	 * @param {number} index - The index of the item to insert before. This must be the last argument.
	 * @returns {number|false} - The index where the first item was inserted, or false if the index is invalid or fewer than two arguments are provided.
	 */
	insertBefore(...args) {
		if (args.length < 2) {
			console.error('insertBefore requires at least two arguments: item(s) and index.')
			return false
		}

		const index = args.pop()
		const itemsToInsert = args

		if (index < 0 || index > this.items.length || !Number.isInteger(index)) {
			console.error(`Invalid index ${index} in insertBefore.`)
			return false
		}

		if (index === 0) {
			this.items.unshift(...itemsToInsert)
		} else {
			this.items.splice(index, 0, ...itemsToInsert)
		}

		return index
	}

	/**
	 * Inserts a new item immediately after the item at the specified index.
	 *
	 * @param {...*} items - Items to insert. The last argument must be the index.
	 * @param {number} index - The index of the item to insert after. This must be the last argument.
	 * @returns {number|false} - The index where the first item was inserted, or false if the index is invalid or fewer than two arguments are provided.
	 */
	insertAfter(...args) {
		if (args.length < 2) {
			console.error('insertAfter requires at least two arguments: item(s) and index.')
			return false
		}

		const index = args.pop()
		const itemsToInsert = args

		if (index < 0 || index >= this.items.length || !Number.isInteger(index)) {
			console.error(`Invalid index ${index} in insertAfter.`)
			return false
		}

		this.items.splice(index + 1, 0, ...itemsToInsert)

		return index + 1
	}

	/**
	 * Calls the callback function for each element in the sequence.
	 * @param {function} callback - The callback function to be called for each element.
	 */
	forEach(callback) {
		this.items.forEach(callback)
	}

	/**
	 * Calls the callback function for each element in the sequence in reverse order.
	 * @param {function} callback - The callback function to be called for each element.
	 */
	reverseForEach(callback) {
		for (let i = this.items.length - 1; i >= 0; i--) {
			callback(this.items[i])
		}
	}

	/**
	 * Returns a new array containing the results of calling a function on every element in the sequence.
	 * @param {function} callback - The callback function to be called for each element.
	 * @returns {Array} - A new array with the results.
	 */
	map(callback) {
		return this.items.map(callback)
	}

	/**
	 * Returns a new array containing all elements of the sequence that pass the test implemented by the provided function.
	 * @param {function} callback - The callback function to test each element.
	 * @returns {Array} - A new array with the filtered elements.
	 */
	filter(callback) {
		return this.items.filter(callback)
	}

	/**
	 * Returns the value of the first element in the sequence that satisfies the provided testing function.
	 * @param {function} callback - The callback function to test each element.
	 * @returns {*} - The value of the first element that satisfies the testing function, or undefined if no elements satisfy the function.
	 */
	find(callback) {
		return this.items.find(callback)
	}

	/**
	 * Returns the index of the first element in the sequence that satisfies the provided testing function.
	 * @param {function(element, index, array): boolean} callback - The callback function to test each element.
	 * @returns {number} - The index of the first element that satisfies the testing function, or -1 if no elements satisfy the function.
	 */
	findIndex(callback) {
		return this.items.findIndex(callback)
	}

	/**
	 * Returns the number of items in the sequence.
	 * @returns {number} - The number of items.
	 */
	get length() {
		return this.items.length
	}

	/**
	 * Removes all items from the sequence.
	 */
	clear() {
		this.items.length = 0
	}

	/**
	 * Removes the item at the specified index.
	 *
	 * @param {number} index - The index of the item to delete.
	 * @returns {*} - The removed item, or undefined if the index is out of bounds.
	 */
	delete(index) {
		if (index < 0 || index >= this.items.length) {
			console.error(`Index ${index} out of bounds in delete.`)
			return undefined
		}

		// Use splice to remove the item
		this.items.splice(index, 1)

		return true
	}

	/**
	 * Retrieves the item at the specified index.
	 *
	 * @param {number} index - The index of the item to retrieve.
	 * @returns {*} - The item at the specified index, or undefined if the index is out of bounds.
	 */
	get(index) {
		if (index < 0 || index >= this.items.length) {
			console.error(`Index ${index} out of bounds in get.`)
			return undefined
		}
		return this.items[index]
	}

	/**
	 * Replaces the item at the specified index with a new item.
	 *
	 * @param {number} index - The index of the item to replace.
	 * @param {*} item - The new item to set.
	 * @returns {*} - The old item that was replaced, or undefined if the index is out of bounds.
	 */
	set(index, item) {
		if (index < 0 || index >= this.items.length) {
			console.error(`Index ${index} out of bounds in set.`)
			return undefined
		}
		const oldItem = this.items[index]
		this.items[index] = item
		return oldItem
	}

	/**
	 * Swaps the items at the specified indices.
	 *
	 * @param {number} index1 - The index of the first item.
	 * @param {number} index2 - The index of the second item.
	 * @returns {boolean} - True if the swap was successful, false if either index is out of bounds.
	 */
	swap(index1, index2) {
		if (index1 < 0 || index1 >= this.items.length || index2 < 0 || index2 >= this.items.length) {
			console.error(`Index out of bounds in swap.`)
			return false
		}

		if (index1 === index2) {
			console.error(`Indices are the same in swap. No swap performed.`)
			return false
		}

		;[this.items[index1], this.items[index2]] = [this.items[index2], this.items[index1]]
		return true
	}

	/**
	 * Adds one or more items to the end of the sequence.
	 *
	 * @param {...*} items - The items to add.
	 * @returns {number} - The new length of the sequence.
	 */
	push(...items) {
		return this.items.push(...items)
	}

	/**
	 * Adds one or more items to the beginning of the sequence.
	 *
	 * @param {...*} items - The items to add.
	 * @returns {number} - The new length of the sequence.
	 */
	unshift(...items) {
		return this.items.unshift(...items)
	}

	/**
	 * Removes and returns the last item in the sequence.
	 *
	 * @returns {*} - The removed item, or undefined if the sequence is empty.
	 */
	pop() {
		return this.items.pop()
	}

	/**
	 * Removes and returns the first item in the sequence.
	 *
	 * @returns {*} - The removed item, or undefined if the sequence is empty.
	 */
	shift() {
		return this.items.shift()
	}

	/**
	 * Checks if the sequence includes a specific item.
	 *
	 * @param {*} item - The item to search for.
	 * @returns {boolean} - True if the item is found, false otherwise.
	 */
	includes(item) {
		return this.items.includes(item)
	}

	/**
	 * Alias for includes.
	 */
	has(item) {
		return this.includes(item)
	}

	*[Symbol.iterator]() {
		yield* this.items
	}

	/**
	 * Returns an iterator for [index, item] pairs.
	 * @returns {Iterator<[number, *]>} - An iterator for [index, item] pairs.
	 */
	*entries() {
		for (let i = 0; i < this.items.length; i++) {
			yield [i, this.items[i]]
		}
	}

	/**
	 * Returns an iterator for the indices (keys) of the items.
	 * @returns {Iterator<number>} - An iterator for the indices.
	 */
	*keys() {
		for (let i = 0; i < this.items.length; i++) {
			yield i
		}
	}

	/**
	 * Alias for Symbol.iterator
	 */
	values() {
		return this[Symbol.iterator]()
	}

	/**
	 * Returns a new ArraySequence containing a portion of the original sequence.
	 *
	 * @param {number} [start=0] - The index to start the slice from.
	 * @param {number} [end=this.length] - The index to end the slice at (exclusive).
	 * @returns {ArraySequence} - A new ArraySequence with the sliced portion.
	 */
	slice(start = 0, end = this.length) {
		const newSequence = new ArraySequence()
		newSequence.items = this.items.slice(start, end)
		return newSequence
	}

	/**
	 * Returns a new ArraySequence that is the concatenation of this sequence and other sequences or arrays.
	 *
	 * @param {...(ArraySequence|Array)} sequences - The sequences or arrays to concatenate.
	 * @returns {ArraySequence} - A new ArraySequence with the concatenated items.
	 */
	concat(...sequences) {
		const newSequence = new ArraySequence()
		newSequence.items = [...this.items] // Start with a copy of this sequence's items

		for (const seq of sequences) {
			if (seq instanceof ArraySequence) {
				newSequence.items.push(...seq.items)
			} else if (Array.isArray(seq)) {
				newSequence.items.push(...seq)
			} else {
				console.error('Invalid argument in concat. Expected ArraySequence or Array.')
			}
		}

		return newSequence
	}

	/**
	 * Reverses the order of the items in the sequence in place.
	 *
	 * @returns {ArraySequence} - The reversed ArraySequence.
	 */
	reverse() {
		this.items.reverse()
		return this
	}

	/**
	 * Fills all the items in the sequence with a static value.
	 *
	 * @param {*} value - The value to fill the sequence with.
	 * @param {number} [start=0] - The index to start filling from.
	 * @param {number} [end=this.length] - The index to end filling at (exclusive).
	 * @returns {ArraySequence} - The filled ArraySequence.
	 */
	fill(value, start = 0, end = this.length) {
		this.items.fill(value, start, end)
		return this
	}

	/**
	 * Removes items outside a specified index range.
	 *
	 * @param {number} start - Starting index (inclusive).
	 * @param {number} [end] - Ending index (inclusive), if not provided, will trim to single element.
	 */
	trim(start, end) {
		if (arguments.length === 0) {
			return console.error('trim() called with no arguments. Use clear() to clear.')
		}

		if (arguments.length === 1) {
			this.items = [this.items[start]]
		} else if (arguments.length === 2) {
			this.items = this.items.slice(start, end + 1)
		} else {
			return console.error(`Invalid trim: too many arguments.`)
		}
	}

	get isEmpty() {
		return this.items.length === 0
	}
}
