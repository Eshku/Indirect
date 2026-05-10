const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { velocity, speed, movementIntent } = ecs.getComponentIDs()
const { lifecycleState } = ecs.getComponentIDs()

const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')
/**
 * This system is responsible for character movement based on their `MovementIntent`.
 * It translates the desired normalized direction vector from `MovementIntent` into a velocity,
 * which is then used by `ApplyVelocity` to update the entity's position.
 */
export class MovementSystem {
	static dependencies = {
		update: {
			reads: [movementIntent, speed],
			writes: [velocity],
		},
	}

	init() {
		this.query = this.getQuery({
			with: [velocity, speed, movementIntent, lifecycleState],
		})
		this.isActiveMaskId = this.getMaskId('isActive')
		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ deltaTime, currentTick, lastTick }) {
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const velocityArrays = this.getComponentData(chunkId, velocity)
			const intentArrays = this.getComponentData(chunkId, movementIntent)
			const speedArrays = this.getComponentData(chunkId, speed)

			const velX = velocityArrays.x
			const velY = velocityArrays.y
			const intentX = intentArrays.desiredX
			const intentY = intentArrays.desiredY
			const speedVal = speedArrays.value

			const activeCount = this.getIndicesFromMask(this.isActiveMaskId, chunkId, this.scratchBuffer)
			for (let j = 0; j < activeCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				velX[indexInChunk] = intentX[indexInChunk] * speedVal[indexInChunk]
				velY[indexInChunk] = intentY[indexInChunk] * speedVal[indexInChunk]
			}
		}
	}

	destroy() {}
}
