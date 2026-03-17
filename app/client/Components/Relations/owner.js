/**
 * A component that links an entity (e.g., an effect or projectile)
 * to its original owner/caster.
 */
export const owner = {
	/**
	 * The entity ID of the owner.
	 */
	entityId: {
		type: 'entity',
		default: 0n,
	},
}
