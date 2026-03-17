/**
 * A component that acts as a buffer to store all collision events for an entity during a single frame.
 * Other systems can read this buffer to react to collisions (e.g., deal damage, apply knockback).
 * This is implemented as a fixed-size array to be cache-friendly and avoid dynamic allocations.
 */
export const collisionBuffer = {
	/**
	 * The current number of collisions recorded in this buffer for this frame.
	 * This is reset to 0 by the CollisionSystem at the start of its update.
	 */
	count: { type: 'u8', default: 0 },
	/**
	 * The maximum number of collisions that can be stored per entity per frame.
	 * This is a shared property, as it's the same for all entities.
	 */
	capacity: { type: 'u8', default: 8 },
	/**
	 * The entity ID of the first collision partner.
	 */
	event0: { type: 'entity', default: 0n },
	/**
	 * The entity ID of the second collision partner.
	 */
	event1: { type: 'entity', default: 0n },
	/**
	 * The entity ID of the third collision partner.
	 */
	event2: { type: 'entity', default: 0n },
	/**
	 * The entity ID of the fourth collision partner.
	 */
	event3: { type: 'entity', default: 0n },
	/**
	 * The entity ID of the fifth collision partner.
	 */
	event4: { type: 'entity', default: 0n },
	/**
	 * The entity ID of the sixth collision partner.
	 */
	event5: { type: 'entity', default: 0n },
	/**
	 * The entity ID of the seventh collision partner.
	 */
	event6: { type: 'entity', default: 0n },
	/**
	 * The entity ID of the eighth collision partner.
	 */
	event7: { type: 'entity', default: 0n },
}