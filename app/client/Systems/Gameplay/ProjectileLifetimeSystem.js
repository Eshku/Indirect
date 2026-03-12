const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { playerProjectile, velocity, range, distanceTraveled, lifecycleState, isPooled } = ecs.getTypeIDs()

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
			without: [isPooled], // Only query for active (not-pooled) projectiles.
		})

		this.LIFECYCLE = ecs.componentManager.getConstantsForProperty('LifecycleState', 'flags')

		// Pre-compile the payload to set the DYING state.
		// CRITICAL: We include dirtyTick in the payload. The value will be set at runtime.
		const { payload, mutators } = this.compile(lifecycleState, { flags: this.LIFECYCLE.DYING, dirtyTick: 0 })
		this.dyingPayload = payload
		this.dyingMutators = mutators
	}

	update({ deltaTime, currentTick }) {
		for (const chunk of this.query.iter()) {
			const velocities = chunk.componentData[velocity]
			const ranges = chunk.componentData[range]
			const distances = chunk.componentData[distanceTraveled]
			// We only need to mark distanceTraveled dirty for the broad-phase check,
			// as no system currently does a narrow-phase check on it.
			let distanceWasModified = false

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				// The query now ensures we only iterate over active projectiles,
				// so we can remove the check for the ACTIVE flag.
				const speed = Math.sqrt(velocities.x[indexInChunk] ** 2 + velocities.y[indexInChunk] ** 2)
				distances.value[indexInChunk] += speed * deltaTime
				distanceWasModified = true

				if (distances.value[indexInChunk] >= ranges.value[indexInChunk]) {
					// This is the correct pattern. We mutate the pre-compiled payload to set the correct tick
					// for the NEXT frame, then issue the command.
					this.dyingMutators.lifecycleState.dirtyTick[0] = currentTick + 1
					this.setComponentData(chunk.entities[indexInChunk], this.dyingPayload)
				}
			}

			if (distanceWasModified) chunk.markDirty(distanceTraveled, currentTick)
		}
	}
}
