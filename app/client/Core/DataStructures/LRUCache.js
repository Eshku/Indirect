/**
 * Dependency-free implementation of a Least Recently Used (LRU) cache.
 * It uses a Map for O(1) lookups and TypedArrays for a memory-efficient
 * doubly-linked list to track recency, minimizing GC overhead. This approach
 * is inspired by the popular 'lru-cache' library.
 *
 * ### Developer Notes: Future Enhancements
 *
 * This implementation is lean and fast, optimized for its current use cases within
 * the engine. More robust, general-purpose LRU caches often include additional
 * features. We may consider adding these if the need arises.
 *
 * #### 1. TTL (Time-To-Live)
 *
 * Allows items to expire after a set duration, not just from being least-used.
 * This is useful for data that can become stale, like cached UI view models.
 *
 * @example TTL Usage
 * const viewModelCache = new LRUCache({
 *   max: 50,
 *   ttl: 5000 // Evict after 5 seconds
 * });
 *
 * #### 2. Disposal Hooks
 *
 * A `dispose(value, key)` function that's called when an item is removed. This is
 * critical for managing external resources, like GPU memory for textures, to
 * prevent memory leaks.
 *
 * @example Disposal Hook for WebGL Textures
 * const textureCache = new LRUCache({
 *   max: 100,
 *   dispose: (texture, key) => {
 *     // 'texture' would be the WebGL texture object
 *     gl.deleteTexture(texture);
 *   }
 * });
 *
 * #### 3. Size-Based Eviction
 *
 * Evicts items based on a total cache size rather than a fixed number of items.
 * This is essential for caching items of variable size, like different resolution
 * textures, while staying within a memory budget.
 *
 * @example Size-Based Eviction for a VRAM Budget
 * const vramCache = new LRUCache({
 *   maxSize: 1024 * 1024 * 256, // 256MB budget
 *   sizeCalculation: (texture) => {
 *     // Return size in bytes
 *     return texture.width * texture.height * 4;
 *   }
 * });
 *
 * #### 4. Asynchronous Fetching (Stale-While-Revalidate)
 *
 * A `fetchMethod` can be provided to retrieve items that are not in the cache.
 * This allows the cache to return a stale value instantly while fetching a fresh
 * one in the background, improving perceived performance.
 *
 * @example Asynchronous Fetching for Player Data
 * const playerProfileCache = new LRUCache({
 *   max: 100,
 *   allowStale: true,
 *   fetchMethod: async (playerId) => {
 *     const response = await fetch(`https://api.mygame.com/players/${playerId}`);
 *     return await response.json();
 *   }
 * });
 *
 * // This would return a stale profile instantly while fetching a new one.
 * const profile = await playerProfileCache.fetch(somePlayerId);
 */
export class LRUCache {
	/**
	 * @param {number} [max=100] - The maximum number of items to store in the cache.
	 */
	constructor(max = 100) {
		this.max = max
		this.size = 0
		this.cache = new Map() // Stores key -> index

		// We use a circular doubly-linked list implemented with TypedArrays.
		// Index 0 is a sentinel node that marks the head/tail of the list,
		// simplifying link/unlink operations.
		const listSize = max + 1
		this.prev = new Uint32Array(listSize)
		this.next = new Uint32Array(listSize)

		// The keys and values are stored in arrays, indexed by the same integers
		// used for the linked list.
		this.keys = new Array(listSize)
		this.values = new Array(listSize)

		// head is the sentinel node at index 0.
		// Most-recently-used (MRU) is at next[head].
		// Least-recently-used (LRU) is at prev[head].
		this.head = 0
		this.prev[0] = 0
		this.next[0] = 0

		// Pointer to the next available free slot.
		this.free = 1
	}

	// Unlinks an entry from the LRU list.
	_unlink(index) {
		const prevIndex = this.prev[index]
		const nextIndex = this.next[index]
		this.next[prevIndex] = nextIndex
		this.prev[nextIndex] = prevIndex
	}

	// Links an entry to the head of the LRU list (making it most-recently-used).
	_linkAtHead(index) {
		const head = this.head
		const mruIndex = this.next[head]
		this.next[head] = index
		this.prev[index] = head
		this.next[index] = mruIndex
		this.prev[mruIndex] = index
	}

	get(key) {
		const index = this.cache.get(key)
		if (index === undefined) {
			return undefined
		}

		// This item is now the most-recently-used, so move it to the head.
		this._unlink(index)
		this._linkAtHead(index)

		return this.values[index]
	}

	/**
	 * Check if a key is in the cache without updating its recency.
	 * @param {*} key - The key to check for.
	 * @returns {boolean} `true` if the key is in the cache, `false` otherwise.
	 */
	has(key) {
		return this.cache.has(key)
	}

	set(key, value) {
		let index = this.cache.get(key)

		// Key already exists, update value and move to head.
		if (index !== undefined) {
			this.values[index] = value
			this._unlink(index)
			this._linkAtHead(index)
			return
		}

		// Key is new, get a free index.
		if (this.size < this.max) {
			// Use the next available free slot.
			index = this.free++
		} else {
			// Evict the least-recently-used item (the one at the tail).
			index = this.prev[this.head]
			this._unlink(index)
			this.cache.delete(this.keys[index])
		}

		// Store new data.
		this.keys[index] = key
		this.values[index] = value
		this.cache.set(key, index)

		// Link the new entry to the head of the list.
		this._linkAtHead(index)

		if (this.size < this.max) {
			this.size++
		}
	}

	/**
	 * Clears the cache, removing all entries.
	 */
	clear() {
		this.size = 0
		this.cache.clear()
		this.head = 0
		this.prev[0] = 0
		this.next[0] = 0
		this.free = 1
	}
}
