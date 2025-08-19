/**
 * A "hot" component that manages an entity's set of active items or skills.
 * It uses a flattened array for its slots to ensure high-performance, cache-friendly
 * access for systems that iterate over many entities with this component.
 */
export class ActiveSet {
	static schema = {
		/**
		 * A fixed-size array holding the entity IDs of the items in each slot.
		 * An ID of 0 represents an empty slot. This is flattened into properties
		 * like `slots0`, `slots1`, etc., for performance.
		 */
		slots: { type: 'array', of: 'u32', capacity: 10 },

		/**
		 * The index of the currently active slot. A value of -1 indicates that
		 * no slot is active.
		 */
		activeSlotIndex: 'i8',
	}

	constructor() {
		this.slots = new Array(10).fill(0)
		this.activeSlotIndex = 0
	}
}
