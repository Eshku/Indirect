const INITIAL_CAPACITY = 256

/**
 * A specialized, allocation-free map for resolving placeholder entity IDs.
 * It uses a BigUint64Array as a direct lookup table, where the array index
 * corresponds to the placeholder's index.
 */
export class PlaceholderMap {
	constructor() {
		this.capacity = INITIAL_CAPACITY
		this.map = new BigUint64Array(this.capacity)
		this.size = 0
	}

	set(placeholderIndex, realId) {
		if (placeholderIndex >= this.capacity) {
			this.resize(placeholderIndex + 1)
		}
		this.map[placeholderIndex] = realId
		if (placeholderIndex >= this.size) {
			this.size = placeholderIndex + 1
		}
	}

	get(placeholderIndex) {
		// A placeholder is only valid if its index is less than the current number
		// of placeholders created in this frame. This prevents reading stale data
		// from a previous, larger frame.
		if (placeholderIndex >= this.size) {
			return 0n // Return null entity for out-of-bounds or stale indices.
		}
		return this.map[placeholderIndex]
	}

	clear() {
		// Zero out the portion of the map that was used in the last frame.
		// This is a crucial step to prevent stale data from leaking between flushes.
		if (this.size > 0) {
			this.map.fill(0n, 0, this.size)
		}
		this.size = 0
	}

	resize(requiredCapacity) {
		const newCapacity = Math.max(this.capacity * 2, requiredCapacity)
		const newMap = new BigUint64Array(newCapacity)
		newMap.set(this.map)
		this.map = newMap
		this.capacity = newCapacity
	}
}