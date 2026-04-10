const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { playerProjectile, velocity, range, distanceTraveled, lifecycleState, isPooled } = ecs.getComponentIDs()

const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')

/**
 * Manages the lifecycle of projectiles with a limited range.
 * It updates their distance traveled and marks them as 'DYING' when they exceed their range.
 */
export class ProjectileLifetimeSystem {
	static dependencies = {
		update: {
			reads: [velocity, range],
			writes: [distanceTraveled, lifecycleState],
		},
	}

	init() {
		this.query = this.getQuery({
			with: [playerProjectile, velocity, range, distanceTraveled, lifecycleState],
			without: [isPooled],
		})
	}

	update({ deltaTime, currentTick }) {

		const chunkIds = this.query.getChunks()
		
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const velocities = this.getComponentData(chunkId, velocity)
			const ranges = this.getComponentData(chunkId, range)
			const distances = this.getComponentData(chunkId, distanceTraveled)
			const states = this.getComponentData(chunkId, lifecycleState)
			const chunkSize = this.getChunkSize(chunkId)

			for (let indexInChunk = 0; indexInChunk < chunkSize; indexInChunk++) {
				
				let chunkModified = false
				const speed = Math.sqrt(velocities.x[indexInChunk] ** 2 + velocities.y[indexInChunk] ** 2)
				distances.value[indexInChunk] += speed * deltaTime

				if (distances.value[indexInChunk] >= ranges.value[indexInChunk]) {
					states.flags[indexInChunk] = LIFECYCLE.DYING
					this.markEntityDirty(chunkId, indexInChunk, lifecycleState, currentTick)
					chunkModified = true
				}

				if (chunkModified) {
					this.markComponentDirty(chunkId, lifecycleState, currentTick)
				}
			}
		}
	}
}
