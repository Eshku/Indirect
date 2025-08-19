/**
 * A simple, dependency-free implementation of a Least Recently Used (LRU) cache.
 * It uses a Map to store data and evicts the oldest entry when the max size is reached.
 */
export class LRUCache {
	/**
	 * @param {number} [max=100] - The maximum number of items to store in the cache.
	 */
	constructor(max = 100) {
		this.max = max
		this.cache = new Map()
	}

	/**
	 * Retrieves an item from the cache. This marks the item as recently used.
	 * @param {*} key - The key of the item to retrieve.
	 * @returns {*|undefined} The cached value, or undefined if not found.
	 */
	get(key) {
		const item = this.cache.get(key)
		if (item) {
			// Refresh the item by deleting and re-setting it, which moves it to the end of the map's insertion order.
			this.cache.delete(key)
			this.cache.set(key, item)
		}
		return item
	}

	/**
	 * Adds or updates an item in the cache.
	 * @param {*} key - The key of the item to set.
	 * @param {*} value - The value of the item.
	 */
	set(key, value) {
		if (this.cache.has(key)) this.cache.delete(key)
		else if (this.cache.size === this.max) this.cache.delete(this.cache.keys().next().value) // Evict oldest
		this.cache.set(key, value)
	}
}