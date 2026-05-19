/**
 * A component that manages the "hit flash" visual effect.
 * This is an `isEnableable` component, meaning its logic only runs when active,
 * and enabling/disabling it is a cheap bitmask operation, not a costly structural change.
 */
export const hitFlash = {
	meta: { isEnableable: true },
	/** time remaining in  hit flash effect. */
	timer: { type: 'f32', default: 0.0 },
	/**  total duration of  hit flash effect. */
	duration: { type: 'f32', default: 0.3 },
}
