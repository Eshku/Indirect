const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager } = ecs

/**
 * A final-pass physics system that integrates velocity into position.
 * This system should run after all other systems that can modify an entity's velocity
 * (e.g., MovementSystem, GravitySystem, JumpSystem) but before the CollisionSystem.
 * This ensures that the final position is based on the fully calculated velocity for the frame.
 */
export class ApplyVelocity {
	constructor() {
		const { position, velocity } = ecs.getTypeIDs()
		Object.assign(this, { position, velocity })

		this.query = queryManager.getQuery({
			with: [position, velocity],
			react: [velocity],
		})
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const positionMarker = chunk.getDirtyMarker(this.position, currentTick)

			const posArrays = chunk.componentArrays[this.position]
			const velArrays = chunk.componentArrays[this.velocity]

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
