const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()

const { queryManager } = ecs

export class GravitySystem {
	constructor() {
		const { isGrounded, velocity } = ecs.getTypeIDs()
		Object.assign(this, { isGrounded, velocity })

		this.query = queryManager.getQuery({
			with: [isGrounded, velocity],
		})
		this.gravity = 800
	}
	init() {}

	update({deltaTime, currentTick, lastTick}) {
		for (const chunk of this.query.iter()) {
			const isGroundedArrays = chunk.componentData[this.isGrounded]
			const velocityArrays = chunk.componentData[this.velocity]
			const velocityDirtyTicks = chunk.dirtyTicks[this.velocity]

			const isGroundedArr = isGroundedArrays.isGrounded
			const velY = velocityArrays.y

			let wasModified = false
			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (!isGroundedArr[indexInChunk]) {
					velY[indexInChunk] -= this.gravity * deltaTime
					velocityDirtyTicks[indexInChunk] = currentTick
					wasModified = true
				}
			}
			if (wasModified) chunk.markChunkDirty(this.velocity, currentTick)
		}
	}

	destroy() {}
}