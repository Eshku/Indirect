const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { position, velocity } = ecs.getComponentIDs()
const { lifecycleState } = ecs.getComponentIDs()

const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')
/**
 * A final-pass physics system that integrates velocity into position.
 * This system should run after all other systems that can modify an entity's velocity
 * (e.g., MovementSystem, GravitySystem, JumpSystem) but before CollisionSystem.
 * This ensures final position is based on fully calculated velocity for frame.
 */
export class ApplyVelocity {
	static dependencies = {
		update: {
			reads: [velocity],
			writes: [position],
		},
	}

	init() {
		this.query = this.getQuery({
			with: [position, velocity, lifecycleState],
		})
		this.isActiveMaskId = this.getMaskId('isActive')
		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ deltaTime, currentTick, lastTick }) {
		// This is a high-volatility system. We assume most entities are moving.
		// We do not use a reactive query and we do not mark any data as dirty.
		// The corresponding reader system (SyncTransforms) will also be non-reactive.
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const posArrays = this.getComponentData(chunkId, position)
			const velArrays = this.getComponentData(chunkId, velocity)

			const activeCount = this.getIndicesFromMask(this.isActiveMaskId, chunkId, this.scratchBuffer)
			for (let j = 0; j < activeCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				posArrays.x[indexInChunk] += velArrays.x[indexInChunk] * deltaTime
				posArrays.y[indexInChunk] += velArrays.y[indexInChunk] * deltaTime
			}
		}
	}

	destroy() {}
}
