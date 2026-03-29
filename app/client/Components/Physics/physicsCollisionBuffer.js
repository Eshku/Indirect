/**
 * A component that acts as a buffer to store all PHYSICS-related collision events for an entity during a single frame.
 * Physics systems (e.g., SeparationSystem) read this buffer to apply forces.
 * This is implemented as a fixed-size array to be cache-friendly and avoid dynamic allocations.
 */
export const physicsCollisionBuffer = {
	tracked: true,

	/**
	 * The current number of collisions recorded in this buffer for this frame.
	 * This is reset to 0 by the CollisionSystem at the start of its update.
	 */
	count: { type: 'u8', default: 0 },
	/**
	 * The maximum number of collisions that can be stored per entity per frame.
	 */
	capacity: { type: 'u8', default: 8 },
	/**
	 * The entity ID of the collision partners.
	 */
	event0: { type: 'entity', default: 0n },
	event1: { type: 'entity', default: 0n },
	event2: { type: 'entity', default: 0n },
	event3: { type: 'entity', default: 0n },
	event4: { type: 'entity', default: 0n },
	event5: { type: 'entity', default: 0n },
	event6: { type: 'entity', default: 0n },
	event7: { type: 'entity', default: 0n },
}