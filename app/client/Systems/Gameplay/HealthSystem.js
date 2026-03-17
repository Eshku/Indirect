const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { health, lifecycleState } = ecs.getTypeIDs()

const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')

/**
 * Monitors entities with health and marks them as 'DYING' when their health drops to zero or below.
 * This system acts as the bridge between taking damage and entering the pooling/cleanup pipeline.
 */
export class HealthSystem {
	static dependencies = {
		// Must run after any system that can modify health (e.g., DamageSystem).
		runsAfter: [ecs.getSystemIDs().DamageSystem],
		update: {
			reads: [health],
			writes: [lifecycleState],
		},
	}

	init() {
		// A reactive query that only triggers for entities whose health has changed.
		this.healthQuery = this.getQuery({
			with: [health, lifecycleState],
			react: [health],
		})

		// Pre-compile the payload to set the DYING state.
		const { payload } = this.compile(lifecycleState, { flags: LIFECYCLE.DYING })
		this.dyingPayload = payload
		this.scratchBuffer = new Uint32Array(4096) // Max chunk capacity
	}

	update({ currentTick, lastTick }) {
		for (const chunk of this.healthQuery.iter()) {
			const healths = chunk.componentData[health]
			const states = chunk.componentData[lifecycleState]
			const changedCount = chunk.getChangedIndices(health, lastTick, this.scratchBuffer)

			for (let i = 0; i < changedCount; i++) {
				const indexInChunk = this.scratchBuffer[i]
				// Check if health has dropped to or below zero.
				if (healths.current[indexInChunk] <= 0) {
					// Only mark as DYING if it's currently ACTIVE. This prevents
					// redundant commands for entities already dying or pooled.
					if ((states.flags[indexInChunk] & LIFECYCLE.ACTIVE) !== 0) {
						const entityId = chunk.entities[indexInChunk]
						this.setComponentData(entityId, this.dyingPayload)
					}
				}
			}
		}
	}
}