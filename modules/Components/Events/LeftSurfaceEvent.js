/**
 * A transient event entity created when a character leaves a surface (e.g., falls off).
 * This is a "hot" component because it is created and destroyed frequently,
 * and its data is a simple primitive that fits well in a TypedArray.
 */
export class LeftSurfaceEvent {
	static schema = {
		entityId: 'u32',
	}

	/**
	 * @param {object} [data={}]
	 * @param {number} data.entityId - The ID of the entity that left the surface.
	 */
	constructor({ entityId = 0 } = {}) {
		this.entityId = entityId
	}
}