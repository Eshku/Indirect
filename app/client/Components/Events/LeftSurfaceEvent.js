/**
 * A transient event component created when a character leaves a surface (e.g., falls off).
 */
export const LeftSurfaceEvent = {
	/**
	 * The ID of the entity that left the surface.
	 */
	entityId: {
		type: 'entity',
		default: 0n,
	},
}
