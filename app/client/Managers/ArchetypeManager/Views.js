//! Outdated.


/**
 * @fileoverview Defines reusable "view" objects for accessing component data.
 *
 * ### Architectural Note: The "Friendly Path" API & Schema Design
 *
 * The classes in this file (`SoAComponentView`, `BitmaskView`, etc.) provide a high-level,
 * object-oriented abstraction over the raw, performance-oriented SoA (Struct-of-Arrays)
 * data layout. They are the core of the "Friendly Path" for component access.
 *
 * 
 *
 * #### Choosing the Right Schema Type
 *
 * The schema type you choose for a component property determines how it's stored and accessed.
 * Use this guide to select the best type for your use case:
 *
 * - **Simple Primitives (e.g., `'f64'`, `'u8'`)**:
 *   - **Use Case**: For simple numeric or boolean properties. This is the most common and performant type.
 *   - **Example**: `Position: { x: 'f64', y: 'f64' }`
 *
 * - **`{ type: 'enum', ... }`**:
 *   - **Use Case**: For a property that can only be in **one state at a time** from a list of mutually exclusive options.
 *   - **Example**: A weapon's state (`IDLE`, `ATTACKING`, `RELOADING`).
 *   - **API**: `entity.weapon.state.value` (gets string), `entity.weapon.state.value = 'ATTACKING'` (sets by string).
 *
 * - **`{ type: 'bitmask', ... }`**:
 *   - **Use Case**: For a property that can be in **multiple states simultaneously**.
 *   - **Example**: A character's status (`STUNNED` and `POISONED` at the same time).
 *   - **API**: `entity.status.flags.has('STUNNED')`, `entity.status.flags.set('POISONED')`.
 *
 * - **`{ type: 'flat_array', ... }`**:
 *   - **Use Case**: For fixed-size collections of simple data, like an inventory hotbar holding entity IDs.
 *   - **Example**: `ActiveItems: { slots: { type: 'flat_array', of: 'u32', capacity: 10 } }`
 *   - **API**: `entity.activeItems.slots[0]`, `entity.activeItems.slots.length`.
 *
 * - **`{ type: 'string'}`**:
 *   - **Use Case**: For string data that is likely to be repeated across many entities (e.g., prefab names, character names). The engine interns these strings to save significant memory.
 *   - **API**: `entity.prefabId.id.equals('some-id')`, `entity.prefabId.id.toString()`.
 *
 *
 * #### Performance Trade-off: Friendly vs. Fast Path
 *
 * Using views introduces overhead compared to direct memory access.
 * For this reason, they are recommended for:
 * - Gameplay logic systems where clarity is key.
 * - UI systems.
 * - One-off or less frequent operations.
 *
 * For performance-critical "hot loop" systems, prefer the "Fast Path" of direct `TypedArray` access
 * as documented in `Accessors.js` and `ModernECS.md`.
 */

/**
 * A generic, reusable "smart view" for components that represent a pure flattened array.
 * It provides a convenient, array-like API for accessing the flattened data
 * while maintaining the performance of direct TypedArray access. It gets its
 * length from a dynamic backing property on the component itself.
 *
 * It is configured by the component class that uses it via a `static ViewConfig` property.
 */
export class FlattenedArrayView {
	constructor(propArrays, prefix, lengthProperty, capacity) {
		this._propArrays = propArrays
		this._index = -1
		this._prefix = prefix
		this._lengthProperty = lengthProperty
		this._fixedLength = capacity

		// This is a bit of a hack to make it array-like. A Proxy would be cleaner but slower.
		// We define properties up to the capacity so that `slots[i]` works.
		for (let i = 0; i < capacity; i++) {
			Object.defineProperty(this, i, {
				get: () => this.getItem(i),
				set: value => this.setItem(i, value),
			})
		}
	}

	/**
	 * Gets the value from a specific slot in the flattened array.
	 * @param {number} slotIndex The index of the slot.
	 * @returns {number|null|undefined} The value (entity ID), `null` for an empty slot, or `undefined` if out of bounds.
	 */
	getItem(slotIndex) {
		if (slotIndex < 0 || slotIndex >= this.length) {
			return undefined
		}
		const value = this._propArrays[`${this._prefix}${slotIndex}`][this._index]
		// The convention is to use 0 for a null/empty entity ID in the TypedArray.
		// The view abstracts this by returning a proper `null`.
		return value === 0 ? null : value
	}

	/**
	 * Sets the value for a specific slot in the flattened array.
	 * @param {number} slotIndex The index of the slot.
	 * @param {*} value The value to set.
	 */
	setItem(slotIndex, value) {
		if (slotIndex < 0 || slotIndex >= this.length) {
			return
		}
		// When setting a value, convert null/undefined/falsey values to 0 to
		// correctly store in the underlying TypedArray.
		this._propArrays[`${this._prefix}${slotIndex}`][this._index] = value || 0
	}

	/**
	 * Returns the item at the specified index. Allows for negative integers,
	 * which indicate an offset from the end of the array.
	 * @param {number} index The index of the item to return.
	 * @returns {number|null|undefined} The value (entity ID), `null` for an empty slot, or `undefined` if out of bounds.
	 */
	at(index) {
		const len = this.length
		if (index < 0) {
			index += len
		}
		return this.getItem(index)
	}

	/**
	 * Executes a provided function once for each array element.
	 * @param {function(number|null, number, FlattenedArrayView): void} callbackFn
	 * @param {*} [thisArg]
	 */
	forEach(callbackFn, thisArg) {
		const len = this.length
		for (let i = 0; i < len; i++) {
			callbackFn.call(thisArg, this.getItem(i), i, this)
		}
	}

	/**
	 * Determines whether the array includes a certain value among its entries.
	 * @param {*} searchElement The value to search for.
	 * @param {number} [fromIndex=0] The position in this array at which to begin searching.
	 * @returns {boolean}
	 */
	includes(searchElement, fromIndex = 0) {
		return this.indexOf(searchElement, fromIndex) !== -1
	}

	/**
	 * Returns the first index at which a given element can be found in the array, or -1 if it is not present.
	 * @param {*} searchElement The value to search for.
	 * @param {number} [fromIndex=0] The position in this array at which to begin searching.
	 * @returns {number}
	 */
	indexOf(searchElement, fromIndex = 0) {
		const len = this.length
		let k = fromIndex >= 0 ? fromIndex : Math.max(len + fromIndex, 0)

		// The view returns `null` for empty slots (value 0), so we need to handle
		// searching for `null` correctly by checking for the underlying 0 value.
		const searchValue = searchElement === null ? 0 : searchElement

		for (; k < len; k++) {
			// Access the raw value for an efficient comparison.
			const value = this._propArrays[`${this._prefix}${k}`][this._index]
			if (value === searchValue) {
				return k
			}
		}
		return -1
	}

	/**
	 * Creates a new array populated with the results of calling a provided function on every element.
	 * @param {function(number|null, number, FlattenedArrayView): *} callbackFn
	 * @param {*} [thisArg]
	 * @returns {Array<*>} A new array with each element being the result of the callback function.
	 */
	map(callbackFn, thisArg) {
		const len = this.length
		const a = new Array(len)
		for (let k = 0; k < len; k++) {
			a[k] = callbackFn.call(thisArg, this.getItem(k), k, this)
		}
		return a
	}

	/**
	 * Returns the value of the first element in the provided array that satisfies the provided testing function.
	 * @param {function(number|null, number, FlattenedArrayView): boolean} predicate
	 * @param {*} [thisArg]
	 * @returns {number|null|undefined}
	 */
	find(predicate, thisArg) {
		const len = this.length
		for (let i = 0; i < len; i++) {
			const value = this.getItem(i)
			if (predicate.call(thisArg, value, i, this)) {
				return value
			}
		}
		return undefined
	}

	/**
	 * Returns a shallow copy of a portion of the view's contents into a new array object.
	 * This implementation is optimized to avoid creating an intermediate full array.
	 * @param {number} [start=0] The beginning of the specified portion of the array.
	 * @param {number} [end=this.length] The end of the specified portion of the array.
	 * @returns {Array<number|null>}
	 */
	slice(start, end) {
		const len = this.length
		let relativeStart = start === undefined ? 0 : start
		let relativeEnd = end === undefined ? len : end

		// Handle negative indices
		if (relativeStart < 0) {
			relativeStart = Math.max(len + relativeStart, 0)
		}
		if (relativeEnd < 0) {
			relativeEnd = Math.max(len + relativeEnd, 0)
		}

		const count = Math.max(0, Math.min(len, relativeEnd) - relativeStart)
		const result = new Array(count)

		for (let i = 0; i < count; i++) {
			result[i] = this.getItem(relativeStart + i)
		}

		return result
	}

	*[Symbol.iterator]() {
		for (let i = 0; i < this.length; i++) {
			yield this.getItem(i)
		}
	}

	get length() {
		// The length is stored in a backing property on the component, whose name
		// is determined by the SchemaParser (e.g., 'slots_count').
		return this._propArrays[this._lengthProperty]?.[this._index] ?? 0
	}

	set length(newValue) {
		const lenProp = this._propArrays[this._lengthProperty]
		if (lenProp) {
			lenProp[this._index] = Math.min(newValue, this._fixedLength)
		}
	}

	/**
	 * The number of items in the array. Alias for `length`.
	 * @type {number}
	 */
	get count() {
		return this.length
	}

	/**
	 * Sets the number of items in the array. Alias for `length`.
	 */
	set count(newValue) {
		this.length = newValue
	}

	/**
	 * Returns a string representation of the array's contents.
	 * @returns {string}
	 */
	toString() {
		const len = this.length
		if (len === 0) {
			return ''
		}

		// This implementation is faster than building an array of strings and then joining.
		let result = ''
		for (let i = 0; i < len; i++) {
			const item = this.getItem(i)
			// Match native [].toString() behavior where null/undefined become empty strings.
			const itemStr = item === null || item === undefined ? '' : String(item)
			result += (i === 0 ? '' : ',') + itemStr
		}
		return result
	}

	/**
	 * Returns a plain array copy of the view's contents.
	 * This is automatically used by `JSON.stringify`.
	 * @returns {Array<number|null>}
	 */
	toJSON() {
		// A flattened array view should serialize to a plain array.
		return this.slice(0, this.length)
	}
}

/**
 * A reusable view for a fixed-capacity, non-interned string.
 * It provides a string-like API while reading/writing directly to a sequence
 * of `u8` properties in the SoA layout.
 */
export class FixedStringView {
	constructor(propArrays, prefix, capacity) {
		// This string type is not "interned" and manages its own byte encoding.
		// It does not need a manager.
		this._encoder = new TextEncoder()
		this._decoder = new TextDecoder()
		this._propArrays = propArrays
		this._prefix = prefix
		this._capacity = capacity
		this._index = -1
	}

	/**
	 * The maximum number of bytes this string can hold.
	 * @type {number}
	 */
	get capacity() {
		return this._capacity
	}

	/**
	 * Sets the value of the string. The input will be truncated if it exceeds capacity.
	 * @param {string} value - The new string value.
	 */
	set(value) {
		const encoded = this._encoder.encode(value)
		const len = Math.min(encoded.length, this._capacity)

		for (let i = 0; i < len; i++) {
			this._propArrays[`${this._prefix}${i}`][this._index] = encoded[i]
		}

		// Fill the rest of the buffer with null terminators
		for (let i = len; i < this._capacity; i++) {
			this._propArrays[`${this._prefix}${i}`][this._index] = 0
		}
	}

	/**
	 * Gets the actual JavaScript string.
	 * This allocates a new string, so avoid it in hot loops if possible.
	 * @returns {string}
	 */
	toString() {
		// This could be optimized by creating a temporary Uint8Array buffer,
		// but for simplicity and since this is a "friendly path", direct access is fine.
		const bytes = []
		for (let i = 0; i < this._capacity; i++) {
			const byte = this._propArrays[`${this._prefix}${i}`][this._index]
			if (byte === 0) {
				// Null terminator found
				break
			}
			bytes.push(byte)
		}

		if (bytes.length === 0) return ''

		return this._decoder.decode(new Uint8Array(bytes))
	}

	/**
	 * Returns the primitive value of the String object.
	 * Allows for implicit string conversion.
	 * @returns {string}
	 */
	valueOf() {
		return this.toString()
	}

	/**
	 * Returns the string value. Used by `JSON.stringify`.
	 * @returns {string}
	 */
	toJSON() {
		return this.toString()
	}
}

/**
 * A reusable, high-performance view for an interned string component.
 * It provides string-like comparison methods without allocating a new JS string.
 */
export class InternedStringView {
	constructor(stringManager, refArray) {
		this._stringManager = stringManager
		this._refArray = refArray
		this._index = -1
		this._cachedString = null
	}

	/**
	 * The length of the string in bytes.
	 * @type {number}
	 */
	get bytes() {
		return this.toString().length // Note: This is char length, not byte length.
	}

	/**
	 * High-performance comparison against a target string.
	 * @param {string} targetString - The string to compare to.
	 * @returns {boolean}
	 */
	equals(targetString) {
		return this.toString() === targetString
	}

	/**
	 * High-performance check if the string starts with a given substring.
	 * @param {string} searchString - The substring to search for.
	 * @returns {boolean}
	 */
	startsWith(searchString) {
		return this.toString().startsWith(searchString)
	}

	/**
	 * High-performance check if the string ends with a given substring.
	 * @param {string} searchString - The substring to search for.
	 * @returns {boolean}
	 */
	endsWith(searchString) {
		return this.toString().endsWith(searchString)
	}

	/**
	 * High-performance check if the string contains a given substring.
	 * @param {string} searchString - The substring to search for.
	 * @returns {boolean}
	 */
	includes(searchString) {
		return this.toString().includes(searchString)
	}

	/**
	 * Gets the actual JavaScript string.
	 * Avoid this in hot loops as it allocates a new string.
	 * @returns {string}
	 */
	toString() {
		// The native string is retrieved directly from the StringManager.
		// This is much faster than decoding bytes.
		if (this._cachedString === null) {
			const ref = this._refArray[this._index]
			this._cachedString = this._stringManager.get(ref)
		}
		return this._cachedString
	}

	/**
	 * Returns the primitive value of the String object.
	 * Allows for implicit string conversion.
	 * @returns {string}
	 */
	valueOf() {
		this._cachedString = null // Invalidate cache on access
		return this.toString()
	}

	/**
	 * Returns the string value. Used by `JSON.stringify`.
	 * @returns {string}
	 */
	toJSON() {
		this._cachedString = null // Invalidate cache on access
		return this.toString()
	}
}

/**
 * A reusable "smart view" for components that represent a bitmask.
 * It provides a convenient, method-based API for checking and modifying flags
 * while abstracting away the underlying bitwise operations.
 */
export class BitmaskView {
	constructor(typedArray, entityIndex, flagMap) {
		this._array = typedArray
		this._index = entityIndex
		this._flags = flagMap
	}

	_resolveFlags(...flagNames) {
		let combinedValue = 0
		for (const name of flagNames) {
			const flagValue = this._flags[name]
			if (flagValue === undefined) {
				console.warn(`BitmaskView: Unknown flag name '${name}'.`)
				continue
			}
			combinedValue |= flagValue
		}
		return combinedValue
	}

	/** Checks if a specific flag is set. */
	has(flagName) {
		const flagValue = this._flags[flagName]
		return (this._array[this._index] & flagValue) !== 0
	}

	/** Checks if ALL of the given flags are set. */
	hasAll(...flagNames) {
		if (flagNames.length === 0) return true
		const combinedValue = this._resolveFlags(...flagNames)
		return (this._array[this._index] & combinedValue) === combinedValue
	}

	/** Checks if ANY of the given flags are set. */
	hasAny(...flagNames) {
		if (flagNames.length === 0) return false
		const combinedValue = this._resolveFlags(...flagNames)
		return (this._array[this._index] & combinedValue) !== 0
	}

	/** Sets one or more flags. */
	set(...flagNames) {
		if (flagNames.length === 0) return
		this._array[this._index] |= this._resolveFlags(...flagNames)
	}

	/** Clears one or more flags. */
	clear(...flagNames) {
		if (flagNames.length === 0) return
		this._array[this._index] &= ~this._resolveFlags(...flagNames)
	}

	/** Toggles one or more flags. */
	toggle(...flagNames) {
		if (flagNames.length === 0) return
		this._array[this._index] ^= this._resolveFlags(...flagNames)
	}

	/** Resets the flags to a specific raw integer value. */
	reset(value = 0) {
		this._array[this._index] = value
	}

	/** Gets the raw integer value of the bitmask. */
	get rawValue() {
		return this._array[this._index]
	}

	/**
	 * Returns a plain array of the names of the currently set flags.
	 * Useful for debugging or serialization.
	 * @returns {string[]}
	 */
	toObject() {
		const setFlags = []
		const currentValue = this.rawValue
		for (const flagName in this._flags) {
			if ((currentValue & this._flags[flagName]) !== 0) {
				setFlags.push(flagName)
			}
		}
		return setFlags
	}

	/**
	 * Returns a serializable representation. Used by `JSON.stringify`.
	 * @returns {string[]}
	 */
	toJSON() {
		return this.toObject()
	}

	/**
	 * Returns a string representation of the set flags.
	 * @returns {string}
	 */
	toString() {
		return this.toObject().join(', ')
	}
}

/**
 * A reusable "smart view" for components that represent an enum.
 * It provides a convenient API for getting and setting the enum's state
 * using its string name, while storing it as an efficient integer.
 */
export class EnumView {
	constructor(typedArray, entityIndex, enumMap, valueMap) {
		this._array = typedArray
		this._index = entityIndex
		this._enumMap = enumMap
		this._valueMap = valueMap
	}

	/** The current string value of the enum. */
	get value() {
		return this._valueMap[this._array[this._index]]
	}

	/** Sets the enum's state using its string name. */
	set value(newValue) {
		const intValue = this._enumMap[newValue]
		if (intValue !== undefined) {
			this._array[this._index] = intValue
		} else {
			console.warn(`EnumView: Unknown enum value '${newValue}'.`)
		}
	}

	/** The raw integer value of the current enum state. */
	get rawValue() {
		return this._array[this._index]
	}

	/** Returns the string value of the enum. */
	toString() {
		return this.value
	}

	/** Returns the string value for JSON serialization. */
	toJSON() {
		return this.value
	}
}

/**
 * A read-only, reusable view object for accessing 'Hot' (SoA) component
 * properties without allowing modification.
 */
export class ReadOnlySoAComponentView {
	constructor(propertyKeys) {
		this._propKeys = propertyKeys
		this._propArrays = {}
		this._index = -1

		for (const key of this._propKeys) {
			Object.defineProperty(this, key, {
				get: () => this._propArrays[key][this._index],
				// No setter is defined, making it read-only.
				enumerable: true,
				configurable: true,
			})
		}
	}

	/**
	 * Creates a plain JavaScript object copy of the component's current state.
	 * Useful for debugging or serialization.
	 * @returns {object}
	 */
	toObject() {
		const obj = {}
		for (const key of this._propKeys) {
			obj[key] = this[key] // Uses the dynamic getter
		}
		return obj
	}

	/**
	 * Returns a plain object representation. Used by `JSON.stringify`.
	 * @returns {object}
	 */
	toJSON() {
		return this.toObject()
	}
}

/**
 * A reusable view object for accessing properties of a 'Hot' (SoA) component
 * without allocating a new object for each access.
 */
export class SoAComponentView {
	constructor(info, propArrays = {}, stringManager) {
		this._info = info
		this._propArrays = propArrays
		this._stringManager = stringManager
		this._index = -1
		this._internedStringViews = {} // Cache for interned string views
		this._flattenedArrayViews = {} // Cache for flattened array views
		this._fixedStringViews = {} // Cache for fixed string views
		this._bitmaskViews = {} // Cache for bitmask views
		this._enumViews = {} // Cache for enum views
		for (const propName of info.originalSchemaKeys) {
			const rep = info.representations[propName]

			if (rep?.type === 'string') {
				const refKey = `${propName}_ref`

				// Create a single, reusable InternedStringView for this property
				if (!this._internedStringViews[propName]) {
					this._internedStringViews[propName] = new InternedStringView(this._stringManager, this._propArrays[refKey])
				}

				// Define a getter that returns the *reusable view* for the interned string property
				Object.defineProperty(this, propName, {
					get: () => {
						const view = this._internedStringViews[propName]
						view._index = this._index // Point the view to the current entity
						view._cachedString = null // Invalidate cache
						return view
					},
					set: value => {
						// The setter expects a raw string. It interns it and updates the underlying arrays.
						if (typeof value !== 'string') {
							console.error(`Attempted to set non-string value to interned string property '${propName}'`)
							return
						}
						const ref = this._stringManager.intern(value)
						this._propArrays[refKey][this._index] = ref
					},
					enumerable: true,
				})
			} else if (rep?.type === 'fixed-string') {
				// Create a single, reusable FixedStringView for this property
				if (!this._fixedStringViews[propName]) {
					// Fixed string still uses byte buffer
					this._fixedStringViews[propName] = new FixedStringView(
						this._propArrays,
						propName, // prefix
						rep.capacity
					)
				}

				// Define a getter that returns the *reusable view* for the fixed string property
				Object.defineProperty(this, propName, {
					get: () => {
						const view = this._fixedStringViews[propName]
						view._index = this._index // Point the view to the current entity
						view._cachedString = null // Invalidate cache
						return view
					},
					set: value => {
						this._fixedStringViews[propName].set(String(value))
					},
				})
			} else if (rep?.type === 'array') {
				// Create a single, reusable FlattenedArrayView for this property
				if (!this._flattenedArrayViews[propName]) {
					this._flattenedArrayViews[propName] = new FlattenedArrayView(
						this._propArrays,
						propName, // prefix
						rep.lengthProperty,
						rep.capacity
					)
				}

				// Define a getter that returns the *reusable view* for the flattened array property
				Object.defineProperty(this, propName, {
					get: () => {
						const view = this._flattenedArrayViews[propName]
						view._index = this._index // Point the view to the current entity
						return view
					},
					enumerable: true,
				})
			} else if (rep?.type === 'bitmask') {
				// Create a single, reusable BitmaskView for this property
				if (!this._bitmaskViews[propName]) {
					this._bitmaskViews[propName] = new BitmaskView(
						this._propArrays[propName],
						-1, // index will be set on get
						rep.flagMap
					)
				}

				// Define a getter that returns the *reusable view* for the bitmask property
				Object.defineProperty(this, propName, {
					get: () => {
						const view = this._bitmaskViews[propName]
						view._index = this._index // Point the view to the current entity
						return view
					},
					set: value => {
						// The setter expects a raw number.
						if (typeof value !== 'number') {
							console.error(`Attempted to set non-numeric value to bitmask property '${propName}'`)
							return
						}
						if (this._propArrays[propName]) {
							this._propArrays[propName][this._index] = value
						}
					},
					enumerable: true,
				})
			} else if (rep?.type === 'enum') {
				// Create a single, reusable EnumView for this property
				if (!this._enumViews[propName]) {
					this._enumViews[propName] = new EnumView(
						this._propArrays[propName],
						-1, // index will be set on get
						rep.enumMap,
						rep.valueMap
					)
				}

				// Define a getter that returns the *reusable view* for the enum property
				Object.defineProperty(this, propName, {
					get: () => {
						const view = this._enumViews[propName]
						view._index = this._index // Point the view to the current entity
						return view
					},
					set: value => {
						// Setter can accept a string or a raw number for convenience.
						if (typeof value === 'string') {
							const intValue = rep.enumMap[value]
							if (intValue !== undefined) {
								this._propArrays[propName][this._index] = intValue
							}
						} else if (typeof value === 'number') {
							// This allows setting via MyComponent.ENUM.MY_VALUE
							this._propArrays[propName][this._index] = value
						} else {
							console.error(`Attempted to set invalid value of type '${typeof value}' to enum property '${propName}'`)
						}
					},
					enumerable: true,
				})
			} else {
				// Simple primitive property
				Object.defineProperty(this, propName, {
					get: () => this._propArrays[propName]?.[this._index],
					set: value => {
						if (this._propArrays[propName]) {
							this._propArrays[propName][this._index] = value
						}
					},
					enumerable: true,
				})
			}
		}
	}

	/**
	 * Returns a string representation of the component.
	 * This is particularly useful for components that wrap a single value, like a shared string.
	 *
	 * - If the component has a single property, it returns the string value of that property.
	 * - Otherwise, it returns a JSON string representation of the component.
	 * @returns {string}
	 */
	toString() {
		const keys = this._info.originalSchemaKeys
		if (keys.length === 1) {
			// this[keys[0]] will use the getter, which for an interned string returns an InternedStringView.
			// The InternedStringView has a toString() method that returns the primitive string.
			return String(this[keys[0]])
		}

		return JSON.stringify(this.toObject())
	}

	/**
	 * Creates a plain JavaScript object copy of the component's current state.
	 * Useful for debugging or serialization.
	 * @returns {object}
	 */
	toObject() {
		const obj = {}
		for (const propName of this._info.originalSchemaKeys) {
			const value = this[propName]
			// The getter for a complex property returns a view. We need to call toJSON() on it
			// to get a serializable value. For simple properties, the value is already a primitive.
			if (value && typeof value.toJSON === 'function') {
				obj[propName] = value.toJSON()
			} else {
				obj[propName] = value
			}
		}
		return obj
	}

	/**
	 * Returns a plain object representation. Used by `JSON.stringify`.
	 * @returns {object}
	 */
	toJSON() {
		return this.toObject()
	}
}
