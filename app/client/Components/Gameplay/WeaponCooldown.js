/**
 * A component that manages a cooldown timer, typically for weapons or abilities.
 */
export const WeaponCooldown = {
	/**
	 * The current time remaining on the cooldown, in seconds.
	 */
	timer: { type: 'f32', default: 0.0 },
}