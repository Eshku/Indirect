/**
 * A component that stores the "threat" cost of an entity.
 * This is used by the SpawnDirectorSystem to manage its budget and can be
 * refunded by other systems, like the OffscreenCleanupSystem.
 */
export const threatCost = {
	value: { type: 'f32', default: 0 },
}