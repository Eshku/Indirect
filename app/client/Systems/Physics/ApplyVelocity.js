const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { position, velocity, isPooled } = ecs.getTypeIDs()

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
			without: [isPooled],
		})
	}

	update({ deltaTime, currentTick, lastTick }) {
		// This is a high-volatility system. We assume most entities are moving.
		// We do not use a reactive query and we do not mark any data as dirty.
		// The corresponding reader system (SyncTransforms) will also be non-reactive.
		for (const chunk of this.query.iter()) {
			const posArrays = chunk.componentData[position]
			const velArrays = chunk.componentData[velocity]

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				// This loop is hot. We just perform the integration. No branching, no marking.
				posArrays.x[indexInChunk] += velArrays.x[indexInChunk] * deltaTime
				posArrays.y[indexInChunk] += velArrays.y[indexInChunk] * deltaTime
			}
		}
	}

	destroy() {}
}
