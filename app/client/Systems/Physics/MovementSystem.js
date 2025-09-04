const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { Velocity, Speed, MovementIntent, CollisionFlags } = componentManager.getComponents()

/**
 * This system is responsible for horizontal character movement based on their `MovementIntent`.
 * It translates the desired direction into velocity, which is then used to update the entity's position.
 * It does not handle gravity or jumping; those are managed by `GravitySystem` and `JumpSystem`.
 */
export class MovementSystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [Velocity, Speed, MovementIntent, CollisionFlags],
		})

		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.speedTypeID = componentManager.getComponentTypeID(Speed)
		this.intentTypeID = componentManager.getComponentTypeID(MovementIntent)
		this.collisionFlagsTypeID = componentManager.getComponentTypeID(CollisionFlags)
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const { componentArrays } = chunk

			const velocityMarker = chunk.getDirtyMarker(this.velocityTypeID, currentTick)

			const velocityArrays = componentArrays[this.velocityTypeID]
			const intentArrays = componentArrays[this.intentTypeID]
			const speedArrays = componentArrays[this.speedTypeID]
			const collisionFlagsArrays = componentArrays[this.collisionFlagsTypeID]

			const velX = velocityArrays.x
			const intentX = intentArrays.desiredX
			const speedVal = speedArrays.value
			const collisionFlags = collisionFlagsArrays.collisionFlags

			for (let i = 0; i < chunk.size; i++) {
				const desiredMoveX = intentX[i]
				const currentCollisionFlags = collisionFlags[i]
				let finalVelX = desiredMoveX * speedVal[i]

				const collidesRight = (currentCollisionFlags & CollisionFlags.COLLISIONFLAGS.RIGHT) !== 0
				const collidesLeft = (currentCollisionFlags & CollisionFlags.COLLISIONFLAGS.LEFT) !== 0

				if ((desiredMoveX > 0 && collidesRight) || (desiredMoveX < 0 && collidesLeft)) {
					finalVelX = 0
				}
				velX[i] = finalVelX

				velocityMarker.mark(i)
			}
		}
	}
}
