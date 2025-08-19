/**
 * A data structure that provides O(1) insertion, deletion, and lookup for a set of
 * non-negative integers.
 *
 * It uses two arrays:
 * - A "dense" array that stores the actual values compactly. This is a TypedArray for performance.
 * - A "sparse" array (a standard JS array) that maps a value to its index in the dense array.
 *
 * This is a pure set and does not store any associated data. For mapping keys to
 * values, see the `SparseMap` class.
 */
export class SparseSet {
	/**
	 * @param {number} [initialCapacity=16] - The initial capacity for the dense arrays.
	 */
	constructor(initialCapacity = 16) {
		this.capacity = initialCapacity
		this.count = 0

		/**
		 * The dense array, storing the items themselves. The order is not guaranteed.
		 * @type {Uint32Array}
		 */
		this.dense = new Uint32Array(this.capacity)

		/**
		 * The sparse array, mapping an item's value to its index in the dense array.
		 * `sparse[itemValue] = denseIndex`.
		 * This remains a standard array because it can be very sparse (e.g., indexed by high entity IDs).
		 * @type {number[]}
		 */
		this.sparse = []
	}

	/**
	 * Resizes the internal typed arrays to a new capacity.
	 * @param {number} newCapacity
	 * @private
	 */
	_resize(newCapacity) {
		const oldDense = this.dense

		this.capacity = newCapacity
		this.dense = new Uint32Array(this.capacity)

		this.dense.set(oldDense)
	}

	/**
	 * Adds a value to the set. If the value already exists, the operation is a no-op.
	 * @param {number} value - The integer value to add.
	 */
	add(value) {
		const denseIndex = this.sparse[value]
		if (denseIndex !== undefined && denseIndex < this.count && this.dense[denseIndex] === value) {
			// Value already exists.
			return
		} else {
			// Add new value.
			if (this.count === this.capacity) {
				// Grow by doubling, or by at least 1 if capacity is 0.
				this._resize(Math.max(1, this.capacity * 2))
			}

			const newDenseIndex = this.count
			this.sparse[value] = newDenseIndex
			this.dense[newDenseIndex] = value
			this.count++
		}
	}

	/**
	 * Checks if a value exists in the set.
	 * This is the canonical "safe" check for a sparse set.
	 * @param {number} value - The value to check.
	 * @returns {boolean}
	 */
	has(value) {
		const denseIndex = this.sparse[value]
		// The bounds check (`denseIndex < this.count`) is crucial for preventing
		// stale entries in the sparse array from giving a false positive.
		return denseIndex !== undefined && denseIndex < this.count && this.dense[denseIndex] === value
	}

	/**
	 * Removes a value from the set. This is an O(1) "swap-and-pop" operation.
	 * @param {number} value - The value to remove.
	 */
	remove(value) {
		const denseIndex = this.sparse[value]
		if (denseIndex === undefined || denseIndex >= this.count || this.dense[denseIndex] !== value) {
			return // Value not in the set.
		}

		this.count--
		const lastValue = this.dense[this.count]

		if (denseIndex < this.count) {
			// If we didn't just pop the item we wanted to remove,
			// we need to move the last item into the removed item's slot.
			this.dense[denseIndex] = lastValue
			this.sparse[lastValue] = denseIndex
		}

		// Invalidate the sparse entry for the removed value.
		this.sparse[value] = undefined
	}

	/**
	 * Clears the set of all values.
	 * This is a fast operation that does not de-allocate memory.
	 */
	clear() {
		this.count = 0
		// It's important to clear the sparse array to remove stale indices.
		// Re-assigning is the fastest way to clear a potentially large sparse array.
		this.sparse = []
	}

	/**
	 * Gets the number of values in the set.
	 * @returns {number}
	 */
	get size() {
		return this.count
	}

	/**
	 * Returns an iterator for the values in the set.
	 * @returns {IterableIterator<number>}
	 */
	*values() {
		for (let i = 0; i < this.count; i++) {
			yield this.dense[i]
		}
	}
}