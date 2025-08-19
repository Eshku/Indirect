/**
 * @fileoverview A high-performance, reusable object for marking components dirty.
 * This is designed to be used within a system's tight loop to reduce function call
 * overhead and redundant checks associated with dirtying components.
 */

export class DirtyMarker {
	constructor() {
		/**
		 * The underlying TypedArray for dirty ticks.
		 * @type {Uint32Array | Array<number> | null}
		 * @private
		 */
		this._array = null;

		/**
		 * The current tick value to write.
		 * @type {number}
		 * @private
		 */
		this._tick = -1;
	}

	/**
	 * Initializes the marker with the necessary data for a specific archetype and component.
	 * This is called by `Archetype.getDirtyMarker`.
	 * @param {Uint32Array | Array<number>} dirtyTicksArray - The array to write to.
	 * @param {number} currentTick - The tick value to write.
	 * @internal
	 */
	_init(dirtyTicksArray, currentTick) {
		this._array = dirtyTicksArray;
		this._tick = currentTick;
	}

	/**
	 * Marks a component at a given index as dirty.
	 * This method is designed to be extremely lightweight and inlinable by the JIT.
	 * @param {number} entityIndex - The index of the entity within the archetype.
	 */
	mark(entityIndex) {
		this._array[entityIndex] = this._tick;
	}
}