const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager } = ecs

export class JumpSystem {
	constructor() {
		const { playerTag, position, velocity, jump, isGrounded } = ecs.getTypeIDs()
		Object.assign(this, { playerTag, position, velocity, jump, isGrounded })

		this.query = queryManager.getQuery({
			with: [playerTag, position, velocity, jump, isGrounded],
		})
	}

	init() {}

	update({deltaTime, currentTick, lastTick}) {
		for (const chunk of this.query.iter()) {
			const velocityArrays = chunk.componentData[this.velocity]
			const jumpArrays = chunk.componentData[this.jump]
			const isGroundedArrays = chunk.componentData[this.isGrounded]

			const velY = velocityArrays.y
			const wantsToJumpArr = jumpArrays.wantsToJump
			const jumpForceArr = jumpArrays.jumpForce
			const isGroundedArr = isGroundedArrays.isGrounded

			let jumpModified = false
			let velocityModified = false

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				// This system is simple enough that we can check and modify in one pass.
				const wantsToJump = wantsToJumpArr[indexInChunk]
				const isGrounded = isGroundedArr[indexInChunk]

				if (wantsToJump && isGrounded) {
					velY[indexInChunk] = jumpForceArr[indexInChunk]

					wantsToJumpArr[indexInChunk] = 0
					// We don't set isGrounded to false here. The CollisionSystem will do that
					chunk.dirtyTicks[this.jump][indexInChunk] = currentTick
					chunk.dirtyTicks[this.velocity][indexInChunk] = currentTick
					jumpModified = true
					velocityModified = true
				}
			}
			
			if (jumpModified) chunk.markChunkDirty(this.jump, currentTick)
			if (velocityModified) chunk.markChunkDirty(this.velocity, currentTick)
		}
	}

	destroy() {}
}
