/**
 * A transient event component created when a character lands on a surface.
 */
export const LandedEvent = {
	/**
	 * The ID of the entity that landed.
	 */
	entityId: {
		type: 'u32',
		default: 0,
	},
}
