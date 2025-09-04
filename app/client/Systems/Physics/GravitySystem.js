const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { IsGrounded, Velocity } = componentManager.getComponents()

export class GravitySystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [IsGrounded, Velocity],
		})
		this.isGroundedTypeID = componentManager.getComponentTypeID(IsGrounded)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.gravity = 800
	}
	init() {}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const velocityMarker = chunk.getDirtyMarker(this.velocityTypeID, currentTick)

			const isGroundedArrays = chunk.componentArrays[this.isGroundedTypeID]
			const velocityArrays = chunk.componentArrays[this.velocityTypeID]

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