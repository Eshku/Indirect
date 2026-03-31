/**
 * A component that grants an entity temporary invulnerability.
 * This is an `isEnableable` component, meaning its logic only runs when active,
 * and enabling/disabling it is a cheap bitmask operation, not a costly structural change.
 */
export const immunity = {
	timer: { type: 'f32', default: 0.0 },

	duration: { type: 'f32', default: 0.5 },
	isEnableable: true,
}
