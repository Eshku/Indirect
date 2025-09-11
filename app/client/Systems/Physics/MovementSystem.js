const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

/**
 * This system is responsible for horizontal character movement based on their `MovementIntent`.
 * It translates the desired direction into velocity, which is then used to update the entity's position.
 * It does not handle gravity or jumping; those are managed by `GravitySystem` and `JumpSystem`.
 */
export class MovementSystem {
	constructor() {
		// Get all numeric IDs at once for efficient use in the update loop.
		const { Velocity, Speed, MovementIntent, CollisionFlags } = componentManager.getTypeIDs()

		// Use numeric type IDs to define the query's structure for efficiency.
		this.query = queryManager.getQuery({
			with: [Velocity, Speed, MovementIntent, CollisionFlags],
		})

		// Cache the numeric IDs on the system instance.
		this.velocityTypeID = Velocity
		this.speedTypeID = Speed
		this.intentTypeID = MovementIntent
		this.collisionFlagsTypeID = CollisionFlags

		// Use the numeric type ID to get constants.
		this.COLLISION_FLAGS = componentManager.getConstantsForProperty(CollisionFlags, 'collisionFlags')
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const velocityMarker = chunk.getDirtyMarker(this.velocityTypeID, currentTick)

			const velocityArrays = chunk.componentArrays[this.velocityTypeID]
			const intentArrays = chunk.componentArrays[this.intentTypeID]
			const speedArrays = chunk.componentArrays[this.speedTypeID]
			const collisionFlagsArrays = chunk.componentArrays[this.collisionFlagsTypeID]

			const velX = velocityArrays.x
			const intentX = intentArrays.desiredX
			const speedVal = speedArrays.value
			const collisionFlagsArray = collisionFlagsArrays.collisionFlags
			const COLLISION_FLAGS = this.COLLISION_FLAGS // Local reference for the tight loop

			for (let i = 0; i < chunk.size; i++) {
				const desiredMoveX = intentX[i] // e.g., -1, 0, 1
				const currentCollisionFlags = collisionFlagsArray[i] // raw bitmask integer
				let finalVelX = desiredMoveX * speedVal[i] // Calculate desired velocity

				// Use the cached constants for direct, highly optimizable bitwise checks.
				const collidesRight = (currentCollisionFlags & COLLISION_FLAGS.RIGHT) !== 0
				const collidesLeft = (currentCollisionFlags & COLLISION_FLAGS.LEFT) !== 0

				// Apply collision logic
				if ((desiredMoveX > 0 && collidesRight) || (desiredMoveX < 0 && collidesLeft)) {
					// Moving right and hit right, or moving left and hit left
					finalVelX = 0
				}
				velX[i] = finalVelX

				velocityMarker.mark(i)
			}
		}
	}
}
