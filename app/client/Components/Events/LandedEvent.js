/**
 * A transient event entity created when a character lands on a surface.
 * This is a "hot" component because it is created and destroyed frequently,
 * and its data is a simple primitive that fits well in a TypedArray.
 */
export class LandedEvent {
	static schema = {
		entityId: 'u32',
	}

	/**
	 * @param {object} [data={}]
	 * @param {number} data.entityId - The ID of the entity that landed.
	 */
	constructor({ entityId = 0 } = {}) {
		this.entityId = entityId
	}
}