const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager } = ecs

/**
 * This system is responsible for horizontal character movement based on their `MovementIntent`.
 * It translates the desired direction into velocity, which is then used to update the entity's position.
 * It does not handle gravity or jumping; those are managed by `GravitySystem` and `JumpSystem`.
 */
export class MovementSystem {
	constructor() {
		// Get all numeric IDs at once for efficient use in the update loop.
		const { velocity, speed, movementIntent, collisionFlags } = ecs.getTypeIDs()
		Object.assign(this, { velocity, speed, movementIntent, collisionFlags })

		// Use numeric type IDs to define the query's structure for efficiency.
		this.query = queryManager.getQuery({
			with: [velocity, speed, movementIntent, collisionFlags],
		})

		// Cache the constants for the 'collisionFlags' property using a camelCase convention.
		this.collisionFlagsConstants = ecs.componentManager.getConstantsForProperty(collisionFlags, 'collisionFlags')
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const velocityMarker = chunk.getDirtyMarker(this.velocity, currentTick)

			const velocityArrays = chunk.componentArrays[this.velocity]
			const intentArrays = chunk.componentArrays[this.movementIntent]
			const speedArrays = chunk.componentArrays[this.speed]
			const collisionFlagsArrays = chunk.componentArrays[this.collisionFlags]

			const velX = velocityArrays.x
			const intentX = intentArrays.desiredX
			const speedVal = speedArrays.value
			const collisionFlagsArray = collisionFlagsArrays.collisionFlags
			const collisionFlags = this.collisionFlagsConstants // Local reference for the tight loop

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				const desiredMoveX = intentX[indexInChunk] // e.g., -1, 0, 1
				const currentCollisionFlags = collisionFlagsArray[indexInChunk] // raw bitmask integer
				let finalVelX = desiredMoveX * speedVal[indexInChunk] // Calculate desired velocity

				// Use the cached constants for direct, bitwise checks.
				const collidesRight = (currentCollisionFlags & collisionFlags.RIGHT) !== 0
				const collidesLeft = (currentCollisionFlags & collisionFlags.LEFT) !== 0

				// Apply collision logic
				if ((desiredMoveX > 0 && collidesRight) || (desiredMoveX < 0 && collidesLeft)) {
					// Moving right and hit right, or moving left and hit left
					finalVelX = 0
				}
				velX[indexInChunk] = finalVelX

				velocityMarker.mark(indexInChunk)
			}
		}
	}
}
