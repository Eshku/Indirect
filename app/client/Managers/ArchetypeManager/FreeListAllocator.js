/**
 * @fileoverview A simple free-list memory allocator for managing ArrayBuffers.
 */

/**
 * Represents a block of memory in the free list.
 * @private
 */
class FreeBlock {
	/**
	 * @param {number} offset
	 * @param {number} size
	 */
	constructor(offset, size) {
		this.offset = offset
		this.size = size
		/** @type {FreeBlock | null} */
		this.next = null
	}
}

/**
 * Manages allocations within a single, larger buffer using a free-list strategy.
 * It maintains a linked list of free blocks, sorted by offset.
 */
export class FreeListAllocator {
	/**
	 * @param {number} capacity Total size of the buffer to manage, in bytes.
	 */
	constructor(capacity) {
		this.capacity = capacity
		/**
		 * The head of the free list.
		 * @private
		 * @type {FreeBlock | null}
		 */
		this._freeListHead = capacity > 0 ? new FreeBlock(0, capacity) : null
	}

	/**
	 * Allocates a block of memory of a given size.
	 * @param {number} size The size of the block to allocate, in bytes.
	 * @returns {number} The offset of the allocated block, or -1 if allocation fails.
	 */
	allocate(size) {
		let previous = null
		let current = this._freeListHead

		while (current) {
			if (current.size >= size) {
				const remainingSize = current.size - size

				if (remainingSize > 0) {
					// Shrink the current block and allocate from the end of it.
					const allocOffset = current.offset
					current.offset += size
					current.size -= size
					return allocOffset
				} else {
					// The block is a perfect fit, remove it from the list
					if (previous) {
						previous.next = current.next
					} else {
						this._freeListHead = current.next
					}
					return current.offset
				}
			}
			previous = current
			current = current.next
		}

		return -1 // Allocation failed
	}

	/**
	 * Deallocates a block of memory, adding it back to the free list.
	 * It merges adjacent free blocks to prevent fragmentation.
	 * @param {number} offset The offset of the block to deallocate.
	 * @param {number} size The size of the block to deallocate.
	 */
	deallocate(offset, size) {
		let previous = null
		let current = this._freeListHead

		// Find the correct position to insert the new free block, sorted by offset
		while (current && current.offset < offset) {
			previous = current
			current = current.next
		}

		// Attempt to merge with the previous block
		if (previous && previous.offset + previous.size === offset) {
			previous.size += size
			// If the newly expanded previous block now touches the current block, merge them too
			if (current && previous.offset + previous.size === current.offset) {
				previous.size += current.size
				previous.next = current.next
			}
			return
		}

		// Attempt to merge with the next block
		if (current && offset + size === current.offset) {
			current.offset = offset
			current.size += size
			return
		}

		// No merge possible, insert a new block
		const newBlock = new FreeBlock(offset, size)
		newBlock.next = current
		if (previous) {
			previous.next = newBlock
		} else {
			this._freeListHead = newBlock
		}
	}

	/**
	 * Clears the allocator and resets it to a single free block of the total capacity.
	 */
	reset() {
		this._freeListHead = this.capacity > 0 ? new FreeBlock(0, this.capacity) : null
	}

    /**
	 * Gets the largest free block size available.
	 * @returns {number}
	 */
	getMaxFreeBlockSize() {
		let max = 0
		let current = this._freeListHead
		while (current) {
			if (current.size > max) {
				max = current.size
			}
			current = current.next
		}
		return max
	}
}