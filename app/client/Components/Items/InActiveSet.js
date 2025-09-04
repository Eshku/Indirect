/**
 * A component that marks an entity as being in an owner's active set of items/skills.
 * This is a "Hot" component for efficient querying.
 */
export class InActiveSet {
	static schema = {
		slot: 'u8', // Slot index 0-9
	}
	constructor({ slot = 0 } = {}) {
		this.slot = slot
	}
}