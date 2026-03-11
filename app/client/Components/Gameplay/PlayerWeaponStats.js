/**
 * A component that stores configuration for a player's weapon systems.
 */
export const PlayerWeaponStats = {
	/**
	 * The number of projectiles to fire in a single shot.
	 */
	count: { type: 'u8', default: 1 },
	/**
	 * The base speed of fired projectiles.
	 */
	speed: { type: 'f32', default: 1500 },
	/**
	 * A factor (0.0 to 1.0) determining how much of the player's velocity is transferred to the projectile along the firing vector.
	 */
	velocityInheritance: { type: 'f32', default: 1 },
	/**
	 * The maximum travel distance of a projectile before it expires.
	 */
	range: { type: 'f32', default: 1000 },
	/**
	 * The time between shots, in seconds.
	 */
	fireRate: { type: 'f32', default: 0.5 },
}