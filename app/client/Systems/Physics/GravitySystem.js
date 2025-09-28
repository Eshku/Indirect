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