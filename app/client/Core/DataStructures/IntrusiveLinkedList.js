/**
 * A low-level, intrusive doubly-linked list implementation that operates on a pre-allocated
 * ArrayBuffer or SharedArrayBuffer.
 *
 * ### Core Concepts
 *
 * 1.  **Intrusive:** The list doesn't store data itself. Instead, the `next` and `prev`
 *     pointers are stored directly within the user's data structures (the "nodes") in
 *     the provided buffer. This avoids memory allocation overhead per-node and improves
 *     cache locality.
 *
 * 2.  **Buffer-Based:** The entire list and its nodes live in a single, contiguous
 *     block of memory (`ArrayBuffer` or `SharedArrayBuffer`), making it suitable for
 *     use in Web Workers with zero-copy data sharing.
 *
 * 3.  **Handles (Bit-Packed):** Instead of returning raw indices or object references,
 *     the list uses 32-bit integer "handles" to identify nodes. A handle packs both
 *     the node's index and a generation counter.
 *
 *     - **Handle Layout (32 bits):**
 *       | Part       | Bits    | Description                                             |
 *       |------------|---------|---------------------------------------------------------|
 *       | Generation | 16 bits | Increments each time a node index is reused.            |
 *       | Index      | 16 bits | The index of the node in the underlying buffer.         |
 *
 *     This mechanism solves the "stale reference" problem. If a handle to a freed node
 *     is used, its generation will not match the current generation for that index,
 *     and the operation will be safely rejected.
 *
 * ### Usage
 *
 * This class is a "manager" for a list within a larger buffer. You provide it with a
 * buffer and tell it where the `next` and `prev` pointers are located within your
 * custom node structure.
 *
 * @example
 * // Define a node structure (e.g., 4 words per node)
 * const STRIDE_IN_U32 = 4;
 * const NEXT_OFFSET = 0; // next pointer is at node_start + 0
 * const PREV_OFFSET = 1; // prev pointer is at node_start + 1
 * const DATA_OFFSET = 2; // custom data starts at node_start + 2
 * const CAPACITY = 100;
 *
 * // Create the buffer and the list manager
 * const buffer = new ArrayBuffer(CAPACITY * STRIDE_IN_U32 * Uint32Array.BYTES_PER_ELEMENT);
 * const list = new IntrusiveLinkedList({
 *   buffer,
 *   capacity: CAPACITY,
 *   stride: STRIDE_IN_U32,
 *   nextOffset: NEXT_OFFSET,
 *   prevOffset: PREV_OFFSET,
 * });
 *
 * // --- Working with the list ---
 *
 * // 1. Allocate a node from the list's free pool
 * const handle1 = list.allocateNode();
 *
 * // 2. Get the raw index to write your data
 * const index1 = list.getIndex(handle1);
 * if (index1 !== -1) {
 *   const nodeStart = index1 * STRIDE_IN_U32;
 *   list.view[nodeStart + DATA_OFFSET] = 123; // Write some data
 * }
 *
 * // 3. Add the node to the list
 * list.push(handle1);
 *
 * // 4. Iterate
 * for (const handle of list) {
 *   const index = list.getIndex(handle);
 *   const data = list.view[index * STRIDE_IN_U32 + DATA_OFFSET];
 *   console.log(`Node data: ${data}`);
 * }
 *
 * // 5. Free the node
 * list.remove(handle1);
 * list.freeNode(handle1);
 */

/**
 * --- ARCHITECTURAL NOTE: IntrusiveLinkedList vs. Sequence (Array) ---
 *
 * This data structure is a specialized tool. Understanding its trade-offs is crucial
 * for using it effectively.
 *
 * ### The Core Trade-Off: Iteration Speed vs. Modification Speed
 *
 * - **Sequence (Array):**
 *   - **Pro:** Extremely fast to iterate. Data is stored contiguously in memory, which is
 *     optimal for the CPU cache (linear access pattern).
 *   - **Con:** Extremely slow to modify. Inserting or removing an item from the middle
 *     requires shifting all subsequent elements in memory (an O(n) operation).
 *
 * - **IntrusiveLinkedList:**
 *   - **Pro:** Extremely fast to modify. Inserting, removing, or re-ordering items is an
 *     O(1) operation that only involves updating a few integer "pointers".
 *   - **Con:** Slower to iterate. Although the nodes live in a single buffer, their
 *     logical order is not sequential in memory. Iteration involves "pointer chasing,"
 *     which can lead to cache misses and is inherently slower than a linear scan.
 *
 * ### Other Key Differences
 *
 * | Feature                  | IntrusiveLinkedList                               | Sequence (Array)                                  |
 * |--------------------------|---------------------------------------------------|---------------------------------------------------|
 * | **Memory Allocation**    | Zero per-node overhead. Uses a pre-allocated pool. | Can cause GC pressure with frequent push/pop.     |
 * | **Reference Stability**  | Handles are stable until a node is explicitly freed. | Indices become invalid when items are removed.    |
 * | **Random Access**        | No (O(n) to find the k-th item).                  | Yes (O(1) access by index).                       |
 *
 * ### When to Use an IntrusiveLinkedList
 *
 * This data structure is the superior choice when your access pattern is dominated by
 * frequent structural changes rather than frequent iteration over the entire list.
 *
 * 1.  **Managing Free Lists:** The `EntityManager`'s pool of `freeChunkIds` is a perfect
 *     example. We only need to add/remove chunk IDs from the pool quickly (O(1)). We
 *     never iterate through the entire list of free chunks.
 *
 * 2.  **Task Queues or Priority Lists:** Systems where items are frequently added, removed,
 *     or re-ordered based on priority. For example, a list of active sound effects
 *     that need to be sorted by importance.
 *
 *     **Note on Priority Queues:** While this can be used for simple priority lists where
 *     insertion order matters or re-ordering is frequent, it is not a true Priority Queue.
 *     For time-based event scheduling (e.g., managing thousands of timers), a heap-based
 *     Priority Queue is far more efficient, offering O(log n) insertion and O(1) access
 *     to the highest-priority item.
 */
export class IntrusiveLinkedList {
	// Constants for handle manipulation
	static NULL_HANDLE = 0xffffffff
	static INDEX_MASK = 0x0000ffff
	static GENERATION_MASK = 0xffff0000
	static GENERATION_SHIFT = 16

	/**
	 * @param {object} config
	 * @param {ArrayBuffer | SharedArrayBuffer} config.buffer The buffer to operate on.
	 * @param {number} config.capacity The maximum number of nodes the buffer can hold.
	 * @param {number} config.stride The size of each node in Uint32Array elements.
	 * @param {number} config.nextOffset The offset within a node to the 'next' pointer.
	 * @param {number} config.prevOffset The offset within a node to the 'prev' pointer.
	 */
	constructor({ buffer, capacity, stride, nextOffset, prevOffset }) {
		if (capacity > 0xffff) {
			throw new Error('Capacity cannot exceed 65535 due to 16-bit index in handle.')
		}

		this.capacity = capacity
		this.stride = stride
		this.nextOffset = nextOffset
		this.prevOffset = prevOffset

		/**
		 * A Uint32Array view over the entire buffer.
		 * @type {Uint32Array}
		 */
		this.view = new Uint32Array(buffer)

		/**
		 * Tracks the generation of each node slot to prevent stale handle usage.
		 * @type {Uint16Array}
		 */
		this.generations = new Uint16Array(capacity)

		/**
		 * The head of the list of active nodes.
		 * @type {number}
		 */
		this.head = IntrusiveLinkedList.NULL_HANDLE

		/**
		 * The tail of the list of active nodes.
		 * @type {number}
		 */
		this.tail = IntrusiveLinkedList.NULL_HANDLE

		/**
		 * The head of the intrusive free list. We use the 'next' pointer of free nodes
		 * to chain them together.
		 * @type {number}
		 */
		this.freeListHead = 0 // Start with index 0

		this.size = 0

		// Initialize the free list and generations
		this.generations.fill(0)
		for (let i = 0; i < capacity; i++) {
			const nodeStart = i * this.stride
			// The next free node is the next one in the buffer
			this.view[nodeStart + this.nextOffset] = i + 1
		}
		// The last node's 'next' points to an invalid index to terminate the list
		if (capacity > 0) {
			const lastNodeStart = (capacity - 1) * this.stride
			this.view[lastNodeStart + this.nextOffset] = 0xffffffff // Use -1 as null index
		} else {
			this.freeListHead = 0xffffffff
		}
	}

	// --- Handle Management ---

	_createHandle(index, generation) {
		return (generation << IntrusiveLinkedList.GENERATION_SHIFT) | index
	}

	/**
	 * Safely gets the raw index from a handle, validating its generation.
	 * @param {number} handle The node handle.
	 * @returns {number} The raw index, or -1 if the handle is null or stale.
	 */
	getIndex(handle) {
		if (handle === IntrusiveLinkedList.NULL_HANDLE) return -1

		const index = handle & IntrusiveLinkedList.INDEX_MASK
		const generation = (handle & IntrusiveLinkedList.GENERATION_MASK) >> IntrusiveLinkedList.GENERATION_SHIFT

		if (index >= this.capacity || this.generations[index] !== generation) {
			return -1 // Stale or invalid handle
		}
		return index
	}

	// --- Node Allocation ---

	/**
	 * Allocates a node from the free list.
	 * @returns {number} A handle to the allocated node, or NULL_HANDLE if the list is full.
	 */
	allocateNode() {
		if (this.freeListHead === 0xffffffff) {
			return IntrusiveLinkedList.NULL_HANDLE // No free nodes
		}

		const index = this.freeListHead
		const nodeStart = index * this.stride

		// Advance the free list head
		this.freeListHead = this.view[nodeStart + this.nextOffset]

		// Initialize the new node's pointers
		this.view[nodeStart + this.nextOffset] = 0xffffffff
		this.view[nodeStart + this.prevOffset] = 0xffffffff

		return this._createHandle(index, this.generations[index])
	}

	/**
	 * Returns a node to the free list.
	 * Note: This does NOT remove the node from the active list. Call `remove()` first.
	 * @param {number} handle The handle of the node to free.
	 */
	freeNode(handle) {
		const index = this.getIndex(handle)
		if (index === -1) return // Invalid handle

		// Increment generation to invalidate old handles
		this.generations[index] = (this.generations[index] + 1) & 0xffff

		const nodeStart = index * this.stride

		// Prepend to the free list
		this.view[nodeStart + this.nextOffset] = this.freeListHead
		this.freeListHead = index
	}

	// --- List Operations ---

	/**
	 * Adds a node to the end of the list.
	 * @param {number} handle The handle of the node to add.
	 */
	push(handle) {
		const index = this.getIndex(handle)
		if (index === -1) return

		const nodeStart = index * this.stride
		this.view[nodeStart + this.prevOffset] = this.getIndex(this.tail)

		if (this.tail !== IntrusiveLinkedList.NULL_HANDLE) {
			const tailIndex = this.getIndex(this.tail)
			const tailStart = tailIndex * this.stride
			this.view[tailStart + this.nextOffset] = index
		} else {
			// List was empty
			this.head = handle
		}

		this.tail = handle
		this.size++
	}

	/**
	 * Adds a node to the beginning of the list.
	 * @param {number} handle The handle of the node to add.
	 */
	unshift(handle) {
		const index = this.getIndex(handle)
		if (index === -1) return

		const nodeStart = index * this.stride
		this.view[nodeStart + this.nextOffset] = this.getIndex(this.head)

		if (this.head !== IntrusiveLinkedList.NULL_HANDLE) {
			const headIndex = this.getIndex(this.head)
			const headStart = headIndex * this.stride
			this.view[headStart + this.prevOffset] = index
		} else {
			// List was empty
			this.tail = handle
		}

		this.head = handle
		this.size++
	}

	/**
	 * Inserts a node before a specified target node in the list.
	 * @param {number} targetHandle The handle of the node to insert before.
	 * @param {number} handleToInsert The handle of the node to be inserted.
	 */
	insertBefore(targetHandle, handleToInsert) {
		const indexToInsert = this.getIndex(handleToInsert)
		if (indexToInsert === -1) return

		const targetIndex = this.getIndex(targetHandle)
		if (targetIndex === -1) return

		const nodeToInsertStart = indexToInsert * this.stride
		const targetNodeStart = targetIndex * this.stride

		// Get the node that was previously before the target.
		const prevNodeIndex = this.view[targetNodeStart + this.prevOffset]

		// --- Link the new node into the list ---
		// 1. New node's `next` points to the target.
		this.view[nodeToInsertStart + this.nextOffset] = targetIndex
		// 2. New node's `prev` points to the target's old previous node.
		this.view[nodeToInsertStart + this.prevOffset] = prevNodeIndex
		// 3. Target's `prev` now points to the new node.
		this.view[targetNodeStart + this.prevOffset] = indexToInsert

		// --- Update the surrounding links ---
		if (prevNodeIndex !== 0xffffffff) {
			// 4a. The old previous node's `next` now points to the new node.
			const prevNodeStart = prevNodeIndex * this.stride
			this.view[prevNodeStart + this.nextOffset] = indexToInsert
		} else {
			// 4b. The target was the head, so the new node is the new head.
			this.head = handleToInsert
		}

		this.size++
	}

	/**
	 * Inserts a node after a specified target node in the list.
	 * @param {number} targetHandle The handle of the node to insert after.
	 * @param {number} handleToInsert The handle of the node to be inserted.
	 */
	insertAfter(targetHandle, handleToInsert) {
		const indexToInsert = this.getIndex(handleToInsert)
		if (indexToInsert === -1) return

		const targetIndex = this.getIndex(targetHandle)
		if (targetIndex === -1) return

		const nodeToInsertStart = indexToInsert * this.stride
		const targetNodeStart = targetIndex * this.stride
		const nextNodeIndex = this.view[targetNodeStart + this.nextOffset]

		this.view[nodeToInsertStart + this.prevOffset] = targetIndex
		this.view[nodeToInsertStart + this.nextOffset] = nextNodeIndex
		this.view[targetNodeStart + this.nextOffset] = indexToInsert

		if (nextNodeIndex !== 0xffffffff) {
			const nextNodeStart = nextNodeIndex * this.stride
			this.view[nextNodeStart + this.prevOffset] = indexToInsert
		} else {
			this.tail = handleToInsert
		}
		this.size++
	}

	/**
	 * Removes and returns the handle of the last node in the list.
	 * @returns {number} The handle of the removed node, or NULL_HANDLE if the list is empty.
	 */
	pop() {
		const handle = this.tail
		if (handle === IntrusiveLinkedList.NULL_HANDLE) {
			return IntrusiveLinkedList.NULL_HANDLE
		}
		this.remove(handle)
		return handle
	}

	/**
	 * Removes and returns the handle of the first node in the list.
	 * @returns {number} The handle of the removed node, or NULL_HANDLE if the list is empty.
	 */
	shift() {
		const handle = this.head
		if (handle === IntrusiveLinkedList.NULL_HANDLE) {
			return IntrusiveLinkedList.NULL_HANDLE
		}
		this.remove(handle)
		return handle
	}

	/**
	 * Clears the list, returning all active nodes to the free list.
	 * This is an O(n) operation as it iterates through all active nodes.
	 */
	clear() {
		let currentHandle = this.head
		while (currentHandle !== IntrusiveLinkedList.NULL_HANDLE) {
			const nextHandle = this.getNext(currentHandle)
			// We don't need to call remove() here, just free the node.
			this.freeNode(currentHandle)
			currentHandle = nextHandle
		}
		this.head = IntrusiveLinkedList.NULL_HANDLE
		this.tail = IntrusiveLinkedList.NULL_HANDLE
		this.size = 0
	}

	/**
	 * Removes a node from the list.
	 * @param {number} handle The handle of the node to remove.
	 */
	remove(handle) {
		const index = this.getIndex(handle)
		if (index === -1) return

		const nodeStart = index * this.stride
		const prevNodeIndex = this.view[nodeStart + this.prevOffset]
		const nextNodeIndex = this.view[nodeStart + this.nextOffset]

		if (prevNodeIndex !== 0xffffffff) {
			const prevNodeStart = prevNodeIndex * this.stride
			this.view[prevNodeStart + this.nextOffset] = nextNodeIndex
		} else {
			// This was the head
			this.head = this.getNext(handle)
		}

		if (nextNodeIndex !== 0xffffffff) {
			const nextNodeStart = nextNodeIndex * this.stride
			this.view[nextNodeStart + this.prevOffset] = prevNodeIndex
		} else {
			// This was the tail
			this.tail = this.getPrev(handle)
		}

		// Clear the node's own pointers for safety
		this.view[nodeStart + this.nextOffset] = 0xffffffff
		this.view[nodeStart + this.prevOffset] = 0xffffffff

		this.size--
	}

	// --- Accessors ---

	/**
	 * Gets the handle of the next node in the list.
	 * @param {number} handle The current node's handle.
	 * @returns {number} The next node's handle, or NULL_HANDLE.
	 */
	getNext(handle) {
		const index = this.getIndex(handle)
		if (index === -1) return IntrusiveLinkedList.NULL_HANDLE

		const nodeStart = index * this.stride
		const nextIndex = this.view[nodeStart + this.nextOffset]

		if (nextIndex === 0xffffffff) return IntrusiveLinkedList.NULL_HANDLE

		return this._createHandle(nextIndex, this.generations[nextIndex])
	}

	/**
	 * Gets the handle of the previous node in the list.
	 * @param {number} handle The current node's handle.
	 * @returns {number} The previous node's handle, or NULL_HANDLE.
	 */
	getPrev(handle) {
		const index = this.getIndex(handle)
		if (index === -1) return IntrusiveLinkedList.NULL_HANDLE

		const nodeStart = index * this.stride
		const prevIndex = this.view[nodeStart + this.prevOffset]

		if (prevIndex === 0xffffffff) return IntrusiveLinkedList.NULL_HANDLE

		return this._createHandle(prevIndex, this.generations[prevIndex])
	}

	// --- Iteration ---

	/**
	 * Returns an iterator for the handles in the list.
	 * @returns {IterableIterator<number>}
	 */
	*[Symbol.iterator]() {
		let currentHandle = this.head
		while (currentHandle !== IntrusiveLinkedList.NULL_HANDLE) {
			yield currentHandle
			currentHandle = this.getNext(currentHandle)
		}
	}
}
