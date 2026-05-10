/**
 * Defines an area-of-effect damage event.
 * An entity with this component will deal damage to other entities within a radius
 * at its position. This is typically used for explosions or ground effects.
 */
export const areaOfEffectDamage = {
	radius: { type: 'f32' },
	// A bitmask that determines which collision groups this AoE can damage.
	// e.g., if mask is 6 (0b0110), it can damage entities in group 1 and group 2.
	mask: { type: 'u32' },
	// A flag to indicate if the damage has been applied, to prevent it from firing every frame.
	hasApplied: { type: 'u8', default: 0 },
}