import { FreeListAllocator } from './FreeListAllocator.js'

/**
 * Manages a single, chunk-local packed array buffer for dynamic arrays.
 * This class encapsulates the SharedArrayBuffer, a FreeListAllocator for memory management,
 * and the logic for allocation, deallocation, reallocation, and compaction.
 */
export class PackedArray {
	/**
	 * @param {number} itemSize The size in bytes of a single item in the array.
	 * @param {number} initialItemCount The initial capacity of the buffer in items.
	 */
	constructor(itemSize, initialItemCount) {
		this.itemSize = itemSize
		this.capacity = initialItemCount
		this.buffer = new SharedArrayBuffer(this.capacity * this.itemSize)
		this.allocator = new FreeListAllocator(this.capacity)
	}

	/**
	 * Allocates a new block of memory for a dynamic array.
	 * @param {number} count The number of items to allocate space for.
	 * @returns {number} The starting index of the allocated block, or -1 on failure.
	 */
	allocate(count) {
		return this.allocator.allocate(count)
	}

	/**
	 * Frees a previously allocated block of memory.
	 * @param {number} startIndex The starting index of the block to free.
	 * @param {number} count The number of items in the block.
	 */
	free(startIndex, count) {
		if (count > 0) {
			this.allocator.deallocate(startIndex, count)
		}
	}

	/**
	 * Attempts to resize an existing allocation.
	 * If it can't be resized in place, it allocates a new block, copies the data, and frees the old block.
	 * This is the core, efficient logic for push/pop operations.
	 * @param {number} oldStartIndex The starting index of the current block.
	 * @param {number} oldLength The current length of the array in items.
	 * @param {number} newLength The desired new length of the array in items.
	 * @returns {{newStartIndex: number, didReallocate: boolean}} The new start index and a flag indicating if the data was moved.
	 */
	reallocate(oldStartIndex, oldLength, newLength) {
		if (newLength === oldLength) {
			return { newStartIndex: oldStartIndex, didReallocate: false }
		}

		// For now, we use a simple allocate-copy-free strategy.
		// A more advanced allocator could try to expand/shrink in place.
		const newStartIndex = this.allocate(newLength)
		if (newStartIndex === -1) {
			return { newStartIndex: -1, didReallocate: false }
		}

		// Copy old data if it exists.
		if (oldLength > 0) {
			const copyLength = Math.min(oldLength, newLength)
			const oldData = new Uint8Array(this.buffer, oldStartIndex * this.itemSize, copyLength * this.itemSize)
			const newData = new Uint8Array(this.buffer, newStartIndex * this.itemSize, copyLength * this.itemSize)
			newData.set(oldData)
		}

		// Free the old block.
		this.free(oldStartIndex, oldLength)

		return { newStartIndex, didReallocate: true }
	}

	/**
	 * Pushes a value onto an array slice within the buffer.
	 * This will reallocate the slice to be one item larger.
	 * @param {number} oldStartIndex The starting index of the current block.
	 * @param {number} oldLength The current length of the array in items.
	 * @param {any} value The value to push.
	 * @param {Function} itemConstructor The TypedArray constructor for the item type.
	 * @returns {{newStartIndex: number, newLength: number}} The new start index and length, or {-1, -1} on failure.
	 */
	push(oldStartIndex, oldLength, value, itemConstructor) {
		const newLength = oldLength + 1
		const { newStartIndex } = this.reallocate(oldStartIndex, oldLength, newLength)

		if (newStartIndex === -1) {
			return { newStartIndex: -1, newLength: -1 }
		}

		// Write the new value to the end of the reallocated block.
		const newValueView = new itemConstructor(this.buffer, (newStartIndex + oldLength) * this.itemSize, 1)
		newValueView[0] = value

		return { newStartIndex, newLength }
	}

	/**
	 * Pops a value from an array slice by reallocating it to be one item smaller.
	 * @param {number} oldStartIndex The starting index of the current block.
	 * @param {number} oldLength The current length of the array in items.
	 * @returns {{newStartIndex: number, newLength: number}} The new start index and length, or {-1, -1} on failure.
	 */
	pop(oldStartIndex, oldLength) {
		if (oldLength === 0) {
			return { newStartIndex: oldStartIndex, newLength: 0 }
		}

		const newLength = oldLength - 1
		const { newStartIndex } = this.reallocate(oldStartIndex, oldLength, newLength)

		if (newStartIndex === -1) {
			// This should ideally not happen for a pop, but handle defensively.
			return { newStartIndex: -1, newLength: -1 }
		}

		return { newStartIndex, newLength }
	}

	clear(oldStartIndex, oldLength) {
		if (oldLength > 0) {
			this.free(oldStartIndex, oldLength)
		}
	}

}