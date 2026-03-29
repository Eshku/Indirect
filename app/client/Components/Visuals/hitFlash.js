/**
 * A component that flags an entity to have a "hit flash" visual effect.
 * This is typically added or enabled when an entity takes damage.
 */
export const hitFlash = {
	duration: { type: 'f32', default: 0.0 },
	maxDuration: { type: 'f32', default: 0.2 },
	// This component's logic should only run when explicitly enabled.
	isEnableable: true,
}