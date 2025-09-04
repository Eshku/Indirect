const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { Position, Velocity, PlayerTag, Jump, IsGrounded } = componentManager.getComponents()


export class JumpSystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [PlayerTag, Position, Velocity, Jump, IsGrounded],
		})

		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.jumpTypeID = componentManager.getComponentTypeID(Jump)
		this.isGroundedTypeID = componentManager.getComponentTypeID(IsGrounded)
	}

	init() {}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const jumpMarker = chunk.getDirtyMarker(this.jumpTypeID, currentTick)
			const velocityMarker = chunk.getDirtyMarker(this.velocityTypeID, currentTick)

			const velocityArrays = chunk.componentArrays[this.velocityTypeID]
			const jumpArrays = chunk.componentArrays[this.jumpTypeID]
			const isGroundedArrays = chunk.componentArrays[this.isGroundedTypeID]

			const velY = velocityArrays.y
			const wantsToJumpArr = jumpArrays.wantsToJump
			const jumpForceArr = jumpArrays.jumpForce
			const isGroundedArr = isGroundedArrays.isGrounded

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				const wantsToJump = wantsToJumpArr[indexInChunk]
				const isGrounded = isGroundedArr[indexInChunk]

				if (wantsToJump && isGrounded) {
					velY[indexInChunk] = jumpForceArr[indexInChunk]

					wantsToJumpArr[indexInChunk] = 0
					// We don't set isGrounded to false here. The CollisionSystem will do that
					jumpMarker.mark(indexInChunk)
					velocityMarker.mark(indexInChunk)
				}
			}
		}
	}
}
