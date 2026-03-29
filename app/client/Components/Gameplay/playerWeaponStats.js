/**
 * A component that stores configuration for a player's weapon systems.
 */
export const playerWeaponStats = {
	/**
	 * The number of projectiles to fire in a single shot.
	 */
	count: { type: 'u8', default: 1 },
	/**
	 * The base speed of fired projectiles.
	 */
	speed: { type: 'f32', default: 1500 },
	/**
	 * The maximum travel distance of a projectile before it expires.
	 */
	range: { type: 'f32', default: 1000 },
	/**
	 * The time between shots, in seconds.
	 */
	fireRate: { type: 'f32', default: 0.5 },
	/**
	 * The base damage dealt by each projectile.
	 */
	damage: { type: 'i32', default: 25 },
}