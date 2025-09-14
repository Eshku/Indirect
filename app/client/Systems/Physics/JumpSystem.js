const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()


export class JumpSystem {
	constructor() {
		const { playerTag, position, velocity, jump, isGrounded } = componentManager.getTypeIDs()
		Object.assign(this, { playerTag, position, velocity, jump, isGrounded })

		this.query = queryManager.getQuery({
			with: [playerTag, position, velocity, jump, isGrounded],
		})
	}

	init() {}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const jumpMarker = chunk.getDirtyMarker(this.jump, currentTick)
			const velocityMarker = chunk.getDirtyMarker(this.velocity, currentTick)

			const velocityArrays = chunk.componentArrays[this.velocity]
			const jumpArrays = chunk.componentArrays[this.jump]
			const isGroundedArrays = chunk.componentArrays[this.isGrounded]

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
