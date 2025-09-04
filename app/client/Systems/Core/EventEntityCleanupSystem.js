const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { LandedEvent, LeftSurfaceEvent } = componentManager.getComponents()

/**
 * This system is responsible for cleaning up transient event entities at the end of each frame.
 *
 * ----------------------------------------------------------------
 *
 * An alternative to creating temporary event entities is to use a reactive query system
 * that watches for changes on a state component.
 *
 * Transient entities are more expensive, but have few advantages:
 * 1.  **Data-Rich Events**: This is a critical advantage. An event can carry specific,
 *     transient data. For example, a `LandedEvent` might contain the `impactVelocity`,
 *     which is crucial for audio and particle systems to react appropriately. A simple
 *     state change (`isGrounded: true`) cannot easily convey this extra context.
 *
 * 2.  **Temporal Persistence (for one frame)**: The event entity exists for the entire
 *     frame's duration, allowing any system, regardless of its execution order, to see
 *     and react to it before it's cleaned up here. This simplifies system ordering logic.
 *
 * 3.  **Handling Multiple Occurrences**: This pattern can handle multiple instances of the
 *     same event happening to the same target entity within a single frame (e.g., a quick
 *     bounce). A reactive query on a state change might only fire once, potentially missing
 *     subsequent occurrences within the same tick.
 *
 * Use it with caution only when needed.
 */
export class EventEntityCleanupSystem {
	constructor() {
		// By querying for any of these event components, we can handle all
		// transient event cleanup in a single pass.
		this.transientEventQuery = queryManager.getQuery({
			any: [LandedEvent, LeftSurfaceEvent],
		})
	}

	update() {
		//delete all in batch based on query.
		this.commands.destroyEntitiesInQuery(this.transientEventQuery)
	}
}
