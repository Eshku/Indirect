const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { playerProjectile, velocity, range, distanceTraveled, lifecycleState, isPooled } = ecs.getTypeIDs()

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
		for (const chunk of this.query.iter()) {
			const velocities = chunk.componentData[velocity]
			const ranges = chunk.componentData[range]
			const distances = chunk.componentData[distanceTraveled]
			const states = chunk.componentData[lifecycleState]

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				const speed = Math.sqrt(velocities.x[indexInChunk] ** 2 + velocities.y[indexInChunk] ** 2)
				distances.value[indexInChunk] += speed * deltaTime

				if (distances.value[indexInChunk] >= ranges.value[indexInChunk]) {
					// We must use setComponentData (not silent) here. This ensures that reactive
					// systems like PoolingSystem are correctly notified of the state change to DYING.
					states.flags[indexInChunk] = LIFECYCLE.DYING
					chunk.markEntityDirty(indexInChunk, lifecycleState, currentTick)
				}
			}
		}
	}
}
