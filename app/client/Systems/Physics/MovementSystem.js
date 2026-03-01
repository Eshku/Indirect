const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager } = ecs

/**
 * This system is responsible for character movement based on their `MovementIntent`.
 * It translates the desired normalized direction vector from `MovementIntent` into a velocity,
 * which is then used by `ApplyVelocity` to update the entity's position.
 */
export class MovementSystem {
	constructor() {
		
		const { velocity, speed, movementIntent } = ecs.getTypeIDs()
		Object.assign(this, { velocity, speed, movementIntent })

		this.query = queryManager.getQuery({
			with: [velocity, speed, movementIntent],
		})
	}

	update({ deltaTime, currentTick, lastTick }) {
		for (const chunk of this.query.iter()) {
			const velocityArrays = chunk.componentData[this.velocity]
			const intentArrays = chunk.componentData[this.movementIntent]
			const speedArrays = chunk.componentData[this.speed]
			const velocityDirtyTicks = chunk.dirtyTicks[this.velocity]

			const velX = velocityArrays.x
			const velY = velocityArrays.y
			const intentX = intentArrays.desiredX
			const intentY = intentArrays.desiredY
			const speedVal = speedArrays.value

			let wasModified = false

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				const finalVelX = intentX[indexInChunk] * speedVal[indexInChunk]
				const finalVelY = intentY[indexInChunk] * speedVal[indexInChunk]

				if (velX[indexInChunk] !== finalVelX || velY[indexInChunk] !== finalVelY) {
					velX[indexInChunk] = finalVelX
					velY[indexInChunk] = finalVelY
					velocityDirtyTicks[indexInChunk] = currentTick
					wasModified = true
				}
			}

			if (wasModified) chunk.markChunkDirty(this.velocity, currentTick)
		}
	}

	destroy() {}
}
