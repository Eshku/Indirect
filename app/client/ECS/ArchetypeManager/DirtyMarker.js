/**
 * Reusable object for marking components dirty.
 * This is designed to be used within a system's tight loop to reduce function call
 * overhead and redundant checks associated with dirtying components.
 */

export class DirtyMarker {
	/**
	 * @param {import('./Chunk.js').Chunk} chunk The chunk this marker belongs to.
	 */
	constructor(chunk) {
		/**
		 * The underlying TypedArray for dirty ticks.
		 * @type {Uint32Array | Array<number> | null}
		 * @private
		 */
		this._array = null

		/**
		 * The current tick value to write.
		 * @type {number}
		 * @private
		 */
		this._tick = -1

		/**
		 * @type {import('./Chunk.js').Chunk}
		 * @private
		 */
		this._chunk = chunk
	}

	/**
	 * @param {Uint32Array | Array<number>} dirtyTicksArray
	 * @param {number} currentTick
	 */
	_init(dirtyTicksArray, currentTick) {
		this._array = dirtyTicksArray
		this._tick = currentTick
	}

	/**
	 * Marks a component at a given index as dirty.
	 * This method is designed to be extremely lightweight and inlinable by the JIT.
	 * @param {number} entityIndex - The index of the entity within the chunk.
	 */
	mark(entityIndex) {
		this._chunk.lastDirtyTick = this._tick
		this._array[entityIndex] = this._tick
	}
}
