/**
 * Represents a single active cooldown.
 * Each entity with this component is a transient cooldown timer.
 */
export const ActiveCooldown = {
	/**
	 * The entity that owns this cooldown (e.g., the player).
	 */
	ownerId: { type: 'entity', default: 0n },
	/**
	 * The prefab ID of the item or skill that is on cooldown.
	 */
	prefabId: { type: 'u32', default: 0 },
	/**
	 * The remaining time in seconds for this cooldown.
	 */
	remainingTime: { type: 'f32', default: 0 },
}