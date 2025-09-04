const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { Position, Velocity } = componentManager.getComponents()

/**
 * A final-pass physics system that integrates velocity into position.
 * This system should run after all other systems that can modify an entity's velocity
 * (e.g., MovementSystem, GravitySystem, JumpSystem) but before the CollisionSystem.
 * This ensures that the final position is based on the fully calculated velocity for the frame.
 */
export class ApplyVelocity {
	constructor() {
		this.query = queryManager.getQuery({
			with: [Position, Velocity],
			react: [Velocity],
		})

		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const positionMarker = chunk.getDirtyMarker(this.positionTypeID, currentTick)

			const posArrays = chunk.componentArrays[this.positionTypeID]
			const velArrays = chunk.componentArrays[this.velocityTypeID]

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				// Only update the position if the velocity has actually changed.
				if (this.query.hasChanged(chunk, indexInChunk)) {
					posArrays.x[indexInChunk] += velArrays.x[indexInChunk] * deltaTime
					posArrays.y[indexInChunk] += velArrays.y[indexInChunk] * deltaTime

					positionMarker.mark(indexInChunk)
				}
			}
		}
	}
}
