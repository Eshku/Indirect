const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()

const { Position, Velocity, Speed, MovementIntent, PhysicsState, BenchmarkTag } = componentManager.getComponents()

/**
 * This system is responsible for horizontal character movement based on their `MovementIntent`.
 * It translates the desired direction into velocity, which is then used to update the entity's position.
 * It does not handle gravity or jumping; those are managed by `GravitySystem` and `JumpSystem`.
 */
export class MovementSystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [Position, Velocity, Speed, MovementIntent, PhysicsState],
		})

		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.speedTypeID = componentManager.getComponentTypeID(Speed)
		this.intentTypeID = componentManager.getComponentTypeID(MovementIntent)
		this.physicsStateTypeID = componentManager.getComponentTypeID(PhysicsState)
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const archetypeData = chunk.archetype

			// Get pre-initialized, cached dirty markers for this archetype.
			const positionMarker = archetypeManager.getDirtyMarker(archetypeData.id, this.positionTypeID, currentTick)
			const velocityMarker = archetypeManager.getDirtyMarker(archetypeData.id, this.velocityTypeID, currentTick)

			// --- Direct Data Access: Get raw TypedArrays once per chunk ---
			const positionArrays = archetypeData.componentArrays[this.positionTypeID]
			const velocityArrays = archetypeData.componentArrays[this.velocityTypeID]
			const intentArrays = archetypeData.componentArrays[this.intentTypeID]
			const speedArrays = archetypeData.componentArrays[this.speedTypeID]
			const physicsStateArrays = archetypeData.componentArrays[this.physicsStateTypeID]

			// Hoist property access out of the loop for JIT optimization.
			const posX = positionArrays.x
			const posY = positionArrays.y
			const velX = velocityArrays.x
			const velY = velocityArrays.y
			const intentX = intentArrays.desiredX
			const speedVal = speedArrays.value
			const collisionFlags = physicsStateArrays.collisionFlags

			for (const entityIndex of chunk) {
				const desiredMoveX = intentX[entityIndex]
				const currentCollisionFlags = collisionFlags[entityIndex]

				// Set velocity based on intent, speed, and collision state.
				let finalVelX = desiredMoveX * speedVal[entityIndex]

				// If trying to move into a wall, stop horizontal movement.
				if (
					(desiredMoveX > 0 && (currentCollisionFlags & PhysicsState.COLLISIONFLAGS.COLLIDE_RIGHT) !== 0) ||
					(desiredMoveX < 0 && (currentCollisionFlags & PhysicsState.COLLISIONFLAGS.COLLIDE_LEFT) !== 0)
				) {
					finalVelX = 0
				}
				velX[entityIndex] = finalVelX

				//  Update position based on final velocity.
				posX[entityIndex] += velX[entityIndex] * deltaTime
				posY[entityIndex] += velY[entityIndex] * deltaTime

				positionMarker.mark(entityIndex)
				velocityMarker.mark(entityIndex)
			}
		}
	}
}
