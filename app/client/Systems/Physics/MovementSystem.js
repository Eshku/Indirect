const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { velocity, speed, movementIntent, isPooled } = ecs.getComponentIDs()

/**
 * This system is responsible for character movement based on their `MovementIntent`.
 * It translates the desired normalized direction vector from `MovementIntent` into a velocity,
 * which is then used by `ApplyVelocity` to update the entity's position.
 */
export class MovementSystem {
	static dependencies = {
		update: {
			reads: [movementIntent, speed],
			writes: [velocity],
		},
	}

	init() {
		this.query = this.getQuery({
			with: [velocity, speed, movementIntent],
			without: [isPooled],
		})
	}

	update({ deltaTime, currentTick, lastTick }) {
		for (const chunk of this.query.iter()) {
			const velocityArrays = chunk.componentData[velocity]
			const intentArrays = chunk.componentData[movementIntent]
			const speedArrays = chunk.componentData[speed]

			const velX = velocityArrays.x
			const velY = velocityArrays.y
			const intentX = intentArrays.desiredX
			const intentY = intentArrays.desiredY
			const speedVal = speedArrays.value

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				velX[indexInChunk] = intentX[indexInChunk] * speedVal[indexInChunk]
				velY[indexInChunk] = intentY[indexInChunk] * speedVal[indexInChunk]
			}
		}
	}

	destroy() {}
}
