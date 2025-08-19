/**
 * @fileoverview Represents a fixed-size, cache-friendly block of entities within an archetype.
 * Queries will yield Chunks instead of entire archetypes, enabling high-performance, parallelizable iteration.
 */

/**
 * The fixed size for a chunk of entities. This is a critical constant for cache-friendly iteration.
 * @type {number}
 */
export const CHUNK_SIZE = 128

/**
 * A high-performance, allocation-free iterator for a Chunk.
 * It has a fast path for dense chunks (no "holes") and a slower path
 * that skips holes for sparse chunks.
 * @private
 */
class ChunkIterator {
	constructor() {
		this.archetype = null
		this.cursor = -1
		this.end = -1
	}

	/**
	 * @param {Chunk} chunk
	 * @internal
	 */
	_init(chunk) {
		this.archetype = chunk.archetype
		this.cursor = chunk.startIndex - 1
		this.end = chunk.startIndex + chunk.count
	}

	next() {
		// With the swap-and-pop strategy, archetypes are always dense.
		// The iterator is now a simple, branch-free increment.
		this.cursor++
		if (this.cursor < this.end) {
			return { value: this.cursor, done: false }
		}
		return { value: undefined, done: true }
	}
}

export class Chunk {
	/**
	 * @param {object} archetype The raw archetype data object this chunk is a view into.
	 * @param {number} startIndex The starting index of this chunk within the archetype's arrays.
	 * @param {number} count The number of entities this chunk spans (which may include "dead" slots).
	 */
	constructor(archetype, startIndex, count) {
		this.archetype = archetype
		this.startIndex = startIndex
		this.count = count
		this._reusableIterator = new ChunkIterator()
	}

	/**
	 * @param {object} archetype The raw archetype data object.
	 * @param {number} startIndex
	 * @param {number} count
	 * @internal
	 */
	_init(archetype, startIndex, count) {
		this.archetype = archetype
		this.startIndex = startIndex
		this.count = count
	}

	/**
	 * The chunk's iterator, which yields only the indices of live entities within its range.
	 * @returns {ChunkIterator} A high-performance, custom iterator.
	 */
	[Symbol.iterator]() {
		this._reusableIterator._init(this)
		return this._reusableIterator
	}
}