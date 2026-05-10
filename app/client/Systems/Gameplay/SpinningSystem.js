const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { rotation, spinning } = ecs.getComponentIDs()
const { lifecycleState } = ecs.getComponentIDs()
const { SyncTransforms } = ecs.getSystemIDs()

const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')
/**
 * This system is responsible for applying a constant rotation to entities
 * that have the `Spinning` component.
 */
export class SpinningSystem {
	static runsBefore = [SyncTransforms]

	static dependencies = {
		update: {
			reads: [spinning],
			writes: [rotation],
		},
	}

	init() {
		this.query = this.getQuery({
			with: [rotation, spinning, lifecycleState],
		})
		this.isActiveMaskId = this.getMaskId('isActive')
		this.scratchBuffer = this.createScratchBuffer()

	}

	update({ deltaTime, currentTick }) {
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const rotationArrays = this.getComponentData(chunkId, rotation)
			const spinningArrays = this.getComponentData(chunkId, spinning)

			const angle = rotationArrays.angle
			const rate = spinningArrays.rate

			const activeCount = this.getIndicesFromMask(this.isActiveMaskId, chunkId, this.scratchBuffer)
			for (let j = 0; j < activeCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				angle[indexInChunk] += rate[indexInChunk] * deltaTime
			}
		}
	}
}