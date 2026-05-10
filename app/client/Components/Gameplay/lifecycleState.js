/**
 * A component that manages an entity's lifecycle state using a bitmask.
 * This is central to the entity pooling pattern.
 */
export const lifecycleState = {
	// An enum field for the entity's exclusive state. The engine will auto-generate
	// a constants object from this definition.
	state: {
		type: 'enum',
		of: {
			SPAWNING: 0,
			ACTIVE: 1, // Normal gameplay participation
			DYING: 2, // In the process of a death animation
			DEAD: 3, // Finished dying, ready for pooling
			POOLED: 4, // In the pool, inactive
		},
		default: 1, // ACTIVE
	},
	// A generic timer for the current state's animation/duration.
	timer: { type: 'f32', default: 0.0 },
	// The total duration for the current state's animation.
	duration: { type: 'f32', default: 0.0 },
}
