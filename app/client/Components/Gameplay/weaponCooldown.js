/**
 * A component that manages a cooldown timer, typically for weapons or abilities.
 */
export const weaponCooldown = {
	meta: { isEnableable: true },
	timer: { type: 'f32', default: 0.0 },
}
