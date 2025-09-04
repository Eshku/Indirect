/**
 * A data structure that maps non-negative integers to 32-bit unsigned integers,
 * providing O(1) insertion, deletion, and lookup.
 *
 * It uses three tightly packed TypedArrays:
 * - A "dense" array that stores the integer keys compactly (`Uint32Array`).
 * - A "sparse" array that maps a key to its index in the dense array.
 * - An "associatedData" array that stores the data, parallel to the dense array (`Uint32Array`).
 *
 * This is ideal for scenarios like mapping an entity's index to its modification tick,
 * which is its primary use case in this ECS.
 *
 * For mapping to arbitrary objects (which would sacrifice cache locality), a different
 * implementation would be needed.
 */
export class SparseMap {
	/**
	 * @param {number} [initialCapacity=16] - The initial capacity for the dense array.
	 */
	constructor(initialCapacity = 16) {
		this.capacity = initialCapacity
		this.count = 0

		/**
		 * The dense array, storing the integer keys themselves. The order is not guaranteed.
		 * @type {Uint32Array}
		 */
		this.dense = new Uint32Array(this.capacity)

		/**
		 * The sparse array, mapping a key's value to its index in the dense array.
		 * `sparse[key] = denseIndex`.
		 * @type {number[]}
		 */
		this.sparse = []

		/**
		 * A parallel array to store data associated with each key in the dense array.
		 * This is a Uint32Array to ensure data is packed tightly for cache performance.
		 * `associatedData[denseIndex]` corresponds to `dense[denseIndex]`.
		 * @type {Uint32Array}
		 */
		this.associatedData = new Uint32Array(this.capacity)
	}

	_resize(newCapacity) {
		const oldDense = this.dense
		const oldAssociated = this.associatedData

		this.capacity = newCapacity
		this.dense = new Uint32Array(this.capacity)
		this.associatedData = new Uint32Array(this.capacity)

		this.dense.set(oldDense)
		this.associatedData.set(oldAssociated)
	}

	/**
	 * Associates a value with a key. If the key already exists, its value is updated.
	 * @param {number} key - The integer key.
	 * @param {*} value - The data to associate with the key.
	 */
	set(key, value) {
		const denseIndex = this.sparse[key]
		if (denseIndex !== undefined && denseIndex < this.count && this.dense[denseIndex] === key) {
			this.associatedData[denseIndex] = value
		} else {
			if (this.count === this.capacity) {
				this._resize(Math.max(1, this.capacity * 2))
			}
			const newDenseIndex = this.count
			this.sparse[key] = newDenseIndex
			this.dense[newDenseIndex] = key
			this.associatedData[newDenseIndex] = value
			this.count++
		}
	}

	/**
	 * Checks if a key exists in the map.
	 * @param {number} key - The key to check.
	 * @returns {boolean}
	 */
	has(key) {
		const denseIndex = this.sparse[key]
		return denseIndex !== undefined && denseIndex < this.count && this.dense[denseIndex] === key
	}

	/**
	 * Removes a key and its associated value from the map using the "swap-and-pop"
	 * algorithm. This ensures the dense arrays remain tightly packed, which is
	 * crucial for cache-friendly iteration.
	 * @param {number} key - The key to remove.
	 */
	delete(key) {
		const denseIndex = this.sparse[key]
		if (denseIndex === undefined || denseIndex >= this.count || this.dense[denseIndex] !== key) {
			return // Key not in the map.
		}

		this.count--
		const lastKey = this.dense[this.count]
		// Since this is a Uint32Array, this is a fast value copy, not a reference copy.
		const lastValue = this.associatedData[this.count]

		if (denseIndex < this.count) {
			// The key to be removed is not the last one in the dense array.
			// To keep the array packed, we move the *last* element into the
			// slot of the element being removed.
			this.dense[denseIndex] = lastKey
			this.associatedData[denseIndex] = lastValue
			// We then update the sparse array to point the moved key to its new dense index.
			this.sparse[lastKey] = denseIndex
		}

		// Finally, we invalidate the sparse entry for the key that was removed.
		this.sparse[key] = undefined
	}

	/**
	 * Retrieves the value associated with a key.
	 * @param {number} key - The key whose associated value is to be retrieved.
	 * @returns {number | undefined} The associated value, or undefined if the key is not in the map.
	 */
	get(key) {
		const denseIndex = this.sparse[key]
		if (denseIndex !== undefined && denseIndex < this.count && this.dense[denseIndex] === key) {
			return this.associatedData[denseIndex]
		}
		return undefined
	}

	/**
	 * Clears the map of all keys and values.
	 */
	clear() {
		this.count = 0
		this.sparse = []
	}

	/**
	 * Gets the number of key-value pairs in the map.
	 * @returns {number}
	 */
	get size() {
		return this.count
	}

	/**
	 * Prunes the map by removing all entries whose value does not meet a condition.
	 * @param {(value: number, key: number) => boolean} predicate - A function that returns true if the item should be kept.
	 */
	prune(predicate) {
		if (this.count === 0) return

		let writeIndex = 0
		for (let readIndex = 0; readIndex < this.count; readIndex++) {
			const key = this.dense[readIndex]
			const value = this.associatedData[readIndex]

			if (predicate(value, key)) {
				if (writeIndex !== readIndex) {
					this.dense[writeIndex] = key
					this.associatedData[writeIndex] = value
					this.sparse[key] = writeIndex
				}
				writeIndex++
			} else {
				this.sparse[key] = undefined
			}
		}
		this.count = writeIndex
	}

	/**
	 * Returns an iterator for the [key, value] pairs in the map.
	 * This is also the default iterator for the class, allowing `for...of` loops.
	 * @returns {IterableIterator<[number, number]>}
	 */
	*[Symbol.iterator]() {
		yield* this.entries()
	}

	/**
	 * Returns an iterator for the [key, value] pairs in the map.
	 * @returns {IterableIterator<[number, number]>}
	 */
	*entries() {
		for (let i = 0; i < this.count; i++) {
			yield [this.dense[i], this.associatedData[i]]
		}
	}

	/**
	 * Returns an iterator for the keys in the map.
	 * @returns {IterableIterator<number>}
	 */
	*keys() {
		for (let i = 0; i < this.count; i++) {
			yield this.dense[i]
		}
	}

	/**
	 * Returns an iterator for the values in the map.
	 * @returns {IterableIterator<number>}
	 */
	*values() {
		for (let i = 0; i < this.count; i++) {
			yield this.associatedData[i]
		}
	}
}
