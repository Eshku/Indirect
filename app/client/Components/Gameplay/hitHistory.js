/**
 * A component that acts as a buffer to store the entity IDs that this entity
 * has already hit and damaged. This is used by piercing projectiles to ensure
 * they only damage a given enemy once during their lifetime.
 */
export const hitHistory = {
	meta: { isTrackable: true },

	/**
	 * The current number of hits recorded in this buffer.
	 * This should be reset to 0 when the entity is reused from a pool.
	 */

	count: { type: 'u8', default: 0 },
	/**
	 * The maximum number of distinct entities this one can damage.
	 */
	capacity: { type: 'u8', default: 16 }, // Let's allow hitting up to 16 enemies.
	event0: { type: 'entity', default: 0n },
	event1: { type: 'entity', default: 0n },
	event2: { type: 'entity', default: 0n },
	event3: { type: 'entity', default: 0n },
	event4: { type: 'entity', default: 0n },
	event5: { type: 'entity', default: 0n },
	event6: { type: 'entity', default: 0n },
	event7: { type: 'entity', default: 0n },
	event8: { type: 'entity', default: 0n },
	event9: { type: 'entity', default: 0n },
	event10: { type: 'entity', default: 0n },
	event11: { type: 'entity', default: 0n },
	event12: { type: 'entity', default: 0n },
	event13: { type: 'entity', default: 0n },
	event14: { type: 'entity', default: 0n },
	event15: { type: 'entity', default: 0n },
}
