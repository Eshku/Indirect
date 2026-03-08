const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { position, velocity } = ecs.getTypeIDs()

/**
 * A final-pass physics system that integrates velocity into position.
 * This system should run after all other systems that can modify an entity's velocity
 * (e.g., MovementSystem, GravitySystem, JumpSystem) but before CollisionSystem.
 * This ensures final position is based on fully calculated velocity for frame.
 */
export class ApplyVelocity {
	init() {
		this.query = this.getQuery({
			with: [position, velocity],
		})
	}

	update({ deltaTime, currentTick, lastTick }) {
		for (const chunk of this.query.iter()) {
			const posArrays = chunk.componentData[position]
			const velArrays = chunk.componentData[velocity]
			const posDirtyTicks = chunk.dirtyTicks[position]

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
			if (wasModified) chunk.markChunkDirty(position, currentTick)
		}
	}

	destroy() {}
}
