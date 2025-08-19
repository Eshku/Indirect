/**
 * @fileoverview A global string interning table to optimize memory and performance.
 * This is not a high-level "Manager" but a core data structure used by the
 * ComponentManager and ArchetypeManager to handle component string data.
 *
 * ### What is String Interning?
 *
 * String interning is a classic memory optimization technique. Instead of storing duplicate
 * string data multiple times, we store the raw bytes for each unique string only once in a
 * large, shared buffer. Components that need to use that string then store a very small,
 * 8-byte pointer (`offset` and `length`) to that location in the shared buffer.
 *
 * ### The "Goblin Army" Example
 *
 * Imagine you have 10,000 goblin entities, and each has a `DisplayName` component with the
 * value "Goblin Grunt".
 *
 * - **Without Interning**: You would store the 12 bytes for "Goblin Grunt" 10,000 times,
 *   costing 120,000 bytes of memory.
 * - **With StringInterningTable**: The bytes for "Goblin Grunt" are stored **once**. Each of the
 *   10,000 `DisplayName` components stores only an 8-byte pointer. The total cost is
 *   (12 bytes) + (10,000 * 8 bytes) = 80,012 bytes, a significant saving that grows as
 *   more entities share the same name.
 *
 * ---
 *
 * ### Dev Guide: How `{ type: 'string' }` works
 *
 * - **Use Case**: For properties that belong to an *entity instance*, where the value can be
 *   different for each entity, but might be duplicated across many entities.
 * - **Examples**: `DisplayName.value`, `PrefabId.id`, `Description.value`.
 * - **Storage**: Each entity stores its own pointer (`offset`, `length`) in its archetype.
 *   The string *content* is stored once globally in the `StringInterningTable`.
 */
const { LRUCache } = await import(`${PATH_CORE}/DataStructures/LRUCache.js`)

export class StringInterningTable {
	constructor() {
		/**
		 * The initial size of the character buffer.
		 * @private
		 */
		this.INITIAL_BUFFER_SIZE = 1024 * 16 // 16KB

		/**
		 * A buffer to hold all unique string data, encoded as UTF-8.
		 * @private
		 * @type {Uint8Array}
		 */
		this.buffer = new Uint8Array(this.INITIAL_BUFFER_SIZE)

		/**
		 * The current number of bytes used in the buffer.
		 * @private
		 */
		this.bufferOffset = 0

		/**
		 * A map from a JavaScript string to its location in the buffer.
		 * @private
		 * @type {Map<string, {offset: number, length: number}>}
		 */
		this.stringMap = new Map()

		/**
		 * A TextEncoder for efficient string-to-UTF8 conversion.
		 * @private
		 */
		this.encoder = new TextEncoder()

		/**
		 * A TextDecoder for efficient UTF8-to-string conversion.
		 * @private
		 */
		this.decoder = new TextDecoder()

		/**
		 * Caches the UTF-8 encoded bytes of recently used strings for comparisons.
		 * This avoids re-encoding the same string repeatedly in a loop, which is a
		 * significant performance win for methods like `equals`, `startsWith`, etc.
		 * @private
		 */
		this.comparisonCache = new LRUCache(100) // Cache up to 100 recently used strings
	}

	/**
	 * Ensures the buffer has enough space for an upcoming write.
	 * @param {number} requiredLength - The number of bytes needed.
	 * @private
	 */
	_ensureCapacity(requiredLength) {
		if (this.bufferOffset + requiredLength > this.buffer.length) {
			const newSize = Math.max(this.buffer.length * 2, this.buffer.length + requiredLength)
			const newBuffer = new Uint8Array(newSize)
			newBuffer.set(this.buffer)
			this.buffer = newBuffer
		}
	}

	/**
	 * Interns a string, storing it in the global buffer if it's not already present.
	 * @param {string} str - The string to intern.
	 * @returns {{offset: number, length: number}} The location of the string in the buffer.
	 */
	intern(str) {
		if (this.stringMap.has(str)) {
			return this.stringMap.get(str)
		}

		const encodedString = this.encoder.encode(str)
		const length = encodedString.length

		this._ensureCapacity(length)

		const offset = this.bufferOffset
		this.buffer.set(encodedString, offset)
		this.bufferOffset += length

		const location = { offset, length }
		this.stringMap.set(str, location)
		return location
	}

	/**
	 * Retrieves a string from the buffer using its location.
	 * This is primarily for debugging or non-performance-critical paths.
	 * @param {number} offset - The starting offset of the string.
	 * @param {number} length - The length of the string in bytes.
	 * @returns {string} The retrieved string.
	 */
	get(offset, length) {
		const stringSlice = this.buffer.subarray(offset, offset + length)
		return this.decoder.decode(stringSlice)
	}

	/**
	 * A private helper to get the cached, encoded representation of a string.
	 * @param {string} str - The string to encode.
	 * @returns {Uint8Array} The encoded string bytes.
	 * @private
	 */
	_getEncodedComparisonString(str) {
		let encoded = this.comparisonCache.get(str)
		if (encoded === undefined) {
			encoded = this.encoder.encode(str)
			this.comparisonCache.set(str, encoded)
		}
		return encoded
	}

	/**
	 * Compares a slice of the buffer to a target string without creating a new string.
	 * This is the high-performance path for accessors.
	 * @param {number} offset - The starting offset of the string in the buffer.
	 * @param {number} length - The length of the string in bytes.
	 * @param {string} targetString - The string to compare against.
	 * @returns {boolean} True if the buffer slice matches the target string.
	 */
	compare(offset, length, targetString) {
		const targetEncoded = this._getEncodedComparisonString(targetString)
		if (length !== targetEncoded.length) return false

		for (let i = 0; i < length; i++) {
			if (this.buffer[offset + i] !== targetEncoded[i]) {
				return false
			}
		}
		return true
	}

	/**
	 * Checks if the buffer slice starts with the given substring without creating a new string.
	 * @param {number} offset The starting offset of the string in the buffer.
	 * @param {number} length The length of the string in bytes.
	 * @param {string} searchString The string to search for.
	 * @returns {boolean}
	 */
	startsWith(offset, length, searchString) {
		const searchEncoded = this._getEncodedComparisonString(searchString)
		if (searchEncoded.length > length) return false

		for (let i = 0; i < searchEncoded.length; i++) {
			if (this.buffer[offset + i] !== searchEncoded[i]) {
				return false
			}
		}
		return true
	}

	/**
	 * Checks if the buffer slice ends with the given substring without creating a new string.
	 * @param {number} offset The starting offset of the string in the buffer.
	 * @param {number} length The length of the string in bytes.
	 * @param {string} searchString The string to search for.
	 * @returns {boolean}
	 */
	endsWith(offset, length, searchString) {
		const searchEncoded = this._getEncodedComparisonString(searchString)
		if (searchEncoded.length > length) return false

		const start = offset + length - searchEncoded.length
		for (let i = 0; i < searchEncoded.length; i++) {
			if (this.buffer[start + i] !== searchEncoded[i]) {
				return false
			}
		}
		return true
	}

	/**
	 * Checks if the buffer slice contains the given substring without creating a new string.
	 * @param {number} offset The starting offset of the string in the buffer.
	 * @param {number} length The length of the string in bytes.
	 * @param {string} searchString The string to search for.
	 * @returns {boolean}
	 */
	includes(offset, length, searchString) {
		const searchEncoded = this._getEncodedComparisonString(searchString)
		if (searchEncoded.length > length) return false

		const mainSlice = this.buffer.subarray(offset, offset + length)

		for (let mainIndex = 0; mainIndex <= mainSlice.length - searchEncoded.length; mainIndex++) {
			let found = true
			for (let searchIndex = 0; searchIndex < searchEncoded.length; searchIndex++) {
				if (mainSlice[mainIndex + searchIndex] !== searchEncoded[searchIndex]) {
					found = false
					break
				}
			}
			if (found) return true
		}
		return false
	}
}