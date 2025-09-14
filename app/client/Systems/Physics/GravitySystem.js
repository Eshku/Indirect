const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

export class GravitySystem {
	constructor() {
		const { isGrounded, velocity } = componentManager.getTypeIDs()
		Object.assign(this, { isGrounded, velocity })

		this.query = queryManager.getQuery({
			with: [isGrounded, velocity],
		})
		this.gravity = 800
	}
	init() {}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const velocityMarker = chunk.getDirtyMarker(this.velocity, currentTick)

			const isGroundedArrays = chunk.componentArrays[this.isGrounded]
			const velocityArrays = chunk.componentArrays[this.velocity]

			const isGroundedArr = isGroundedArrays.isGrounded
			const velY = velocityArrays.y

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (!isGroundedArr[indexInChunk]) {
					velY[indexInChunk] -= this.gravity * deltaTime
					velocityMarker.mark(indexInChunk)
				}
			}
		}
	}
}