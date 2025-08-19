const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { LandedEvent, LeftSurfaceEvent } = componentManager.getComponents()

/**
 * This system is responsible for cleaning up transient event entities at the end of a frame.
 * Event entities (like those with LandedEvent) are messages that other systems
 * can react to. By destroying them here, we ensure they persist long enough for all
 * interested systems to process them, but are cleared before the next frame.
 */
export class EventEntityCleanupSystem {
	constructor() {
		this.landedEventQuery = queryManager.getQuery({
			with: [LandedEvent],
		})
		this.leftSurfaceEventQuery = queryManager.getQuery({
			with: [LeftSurfaceEvent],
		})

		this.commands = null // Injected by SystemManager
	}

	update() {
		this._cleanupEvents(this.landedEventQuery)
		this._cleanupEvents(this.leftSurfaceEventQuery)
	}

	_cleanupEvents(query) {
		for (const chunk of query.iter()) {
			for (const entityIndex of chunk) {
				this.commands.destroyEntity(chunk.archetype.entities[entityIndex])
			}
		}
	}
}