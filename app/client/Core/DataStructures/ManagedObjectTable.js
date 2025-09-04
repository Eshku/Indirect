/**
 * @fileoverview A table for managing the lifecycle of complex JavaScript objects.
 *
 * ### Architectural Note: The "Handle" Pattern
 *
 * This class is the cornerstone of the "100% Hot Data" architecture. Instead of
 * storing complex objects (like `Map`, `Set`, or PIXI `DisplayObject`s) directly
 * in a "cold" component, we store them here. The component, now converted to a
 * "hot" component, stores only a lightweight `u32` integer called a "handle".
 *
 * This approach has two major benefits:
 * 1.  **Unified Data Path**: All components become "hot", simplifying the `ArchetypeManager`
 *     and eliminating the performance-sapping `if/else` branches for hot/cold data.
 * 2.  **Predictable Memory**: It allows for explicit lifetime management of objects,
 *     preventing common JavaScript GC pauses and giving us more control over memory.
 *
 * ### Lifetime Management: Reference Counting
 *
 * This table uses reference counting to manage object lifetimes.
 * - **`add(obj)`**: When an object is first added, it gets a handle and its reference count is set to 1.
 * - **`acquire(handle)`**: If another part of the engine needs to share a reference to the
 *   same object, it should call `acquire()` to increment the reference count.
 * - **`release(handle)`**: When a reference is no longer needed, `release()` is called. This
 *   decrements the count. When the count reaches zero, the object is removed from the
 *   table and its handle is recycled for future use.
 *
 * This prevents memory leaks by ensuring that objects are only truly removed when nothing
 * in the engine is using them anymore.
 */

export class ManagedObjectTable {
	constructor() {
		/**
		 * The main store for our managed objects. Index 0 is reserved for the null handle.
		 * Each entry is an object containing the managed object and its reference count.
		 * @private
		 * @type {Array<{obj: any, refCount: number} | null>}
		 */
		this.objects = [null]

		/**
		 * A list of recycled handles (indices) that are free to be reused.
		 * This prevents the `objects` array from growing indefinitely.
		 * @private
		 * @type {number[]}
		 */
		this.freeList = []
	}

	/**
	 * Adds a new object to the table, giving it a reference count of 1.
	 * @param {any} obj - The complex object to manage (e.g., a Map, a PIXI.Sprite).
	 * @returns {number} The handle (integer ID) for the newly added object.
	 */
	add(obj) {
		const entry = { obj, refCount: 1 }

		if (this.freeList.length > 0) {
			const handle = this.freeList.pop()
			this.objects[handle] = entry
			return handle
		}

		this.objects.push(entry)
		return this.objects.length - 1
	}

	/**
	 * Retrieves an object from the table using its handle.
	 * @param {number} handle - The handle of the object to retrieve.
	 * @returns {any | undefined} The object, or undefined if the handle is invalid.
	 */
	get(handle) {
		return this.objects[handle]?.obj
	}

	/**
	 * Increments the reference count for a given handle.
	 * This should be called when a new part of the engine starts referencing an existing object.
	 * @param {number} handle - The handle of the object to acquire.
	 */
	acquire(handle) {
		const entry = this.objects[handle]
		if (entry) {
			entry.refCount++
		} else {
			console.warn(`ManagedObjectTable: Attempted to acquire invalid handle ${handle}.`)
		}
	}

	/**
	 * Decrements the reference count for a given handle.
	 * If the reference count drops to zero, the object is removed and the handle is recycled.
	 * @param {number} handle - The handle of the object to release.
	 * @param {function(any): void} [destroyFn] - An optional function to call on the object
	 *   before it's removed, useful for cleanup (e.g., `sprite.destroy()`).
	 */
	release(handle, destroyFn) {
		if (handle === 0 || !this.objects[handle]) {
			// Silently ignore releases of null or invalid handles.
			return
		}

		const entry = this.objects[handle]
		entry.refCount--

		if (entry.refCount <= 0) {
			if (destroyFn && typeof destroyFn === 'function') {
				try {
					destroyFn(entry.obj)
				} catch (e) {
					console.error(`ManagedObjectTable: Error in destroy function for handle ${handle}:`, e)
				}
			}

			// Nullify the entry and add the handle to the free list for recycling.
			this.objects[handle] = null
			this.freeList.push(handle)
		}
	}
}