/**
 * A component to store a "magic number" (the creation tick) for entities
 * in the ChurnTestSystem, used for data integrity verification.
 */
export const churnData = {
	/**
	 * The game tick when the entity was created.
	 */
	creationTick: {
		type: 'u32',
		default: 0,
	},
	entityId: { type: 'entity', default: 0n },
}
