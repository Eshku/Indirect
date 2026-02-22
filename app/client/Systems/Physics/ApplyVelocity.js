const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager } = ecs

/**
 * A final-pass physics system that integrates velocity into position.
 * This system should run after all other systems that can modify an entity's velocity
 * (e.g., MovementSystem, GravitySystem, JumpSystem) but before CollisionSystem.
 * This ensures final position is based on fully calculated velocity for frame.
 */
export class ApplyVelocity {
	constructor() {
		const { position, velocity } = ecs.getTypeIDs()
		Object.assign(this, { position, velocity })

		this.query = queryManager.getQuery({
			with: [position, velocity],
		})
	}

	update({deltaTime, currentTick, lastTick}) {

		for (const chunk of this.query.iter()) {
			const posArrays = chunk.componentData[this.position]
			const velArrays = chunk.componentData[this.velocity]
			const posDirtyTicks = chunk.dirtyTicks[this.position]

			let wasModified = false
			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				const velX = velArrays.x[indexInChunk]
				const velY = velArrays.y[indexInChunk]

				// Only update position if the entity is actually moving.
				if (velX !== 0 || velY !== 0) {
					posArrays.x[indexInChunk] += velX * deltaTime
					posArrays.y[indexInChunk] += velY * deltaTime
					posDirtyTicks[indexInChunk] = currentTick
					wasModified = true
				}
			}
			if (wasModified) chunk.markChunkDirty(this.position, currentTick)
		}
	}

	destroy() {}
}
