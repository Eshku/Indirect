/**
 * A component that links an entity (e.g., an effect or projectile)
 * to its original owner/caster.
 */
export const Owner = {
	/**
	 * The entity ID of the owner.
	 */
	entityId: {
		type: 'u32',
		default: 0,
	},
}
