/**
 * A component for entities that should exist for a fixed duration and then be destroyed.
 * Useful for temporary effects like explosions, particle effects, or short-lived projectiles.
 */
export const lifetime = {
	timer: { type: 'f32', default: 1.0 },
	duration: { type: 'f32', default: 1.0 },
}
