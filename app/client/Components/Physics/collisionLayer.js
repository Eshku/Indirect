/**
 * A component that defines an entity's physics collision group and mask.
 * Used by collision system to determine which entities can interact.
 */
export const collisionLayer = {
	/**
	 * Collision group this entity belongs to.
	 * This must be a raw numeric value with a single bit set (e.g., 1, 2, 4, 8...).
	 * Definitions for these groups are in `PhysicsManager.js`.
	 * @example
	 * // In a prefab: "collisionLayer": { "group": 1 } // for PLAYER
	 */
	group: {
		type: 'u32',
		default: 0,
	},
}