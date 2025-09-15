/**
 * A transient event component created when a character lands on a surface.
 */
export const LandedEvent = {
	/**
	 * The ID of the entity that landed.
	 */
	entityId: {
		type: 'entity',
		default: 0n,
	},
}
