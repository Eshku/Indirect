const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { lifecycleState, isPooled } = ecs.getTypeIDs()

const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')

/**
 * A generalized system that manages the final step of entity pooling.
 * It queries for entities marked as 'DYING' by other systems (e.g., health, lifetime systems)
 * and transitions them into the 'POOLED' state by adding the `isPooled` tag.
 * This decouples the logic of "deciding to die" from the mechanics of "entering the pool".
 */
export class PoolingSystem {
	static dependencies = {
		// This system performs structural changes (adding isPooled) and writes to lifecycleState.
		update: {
			writes: [lifecycleState, isPooled],
		},
	}

	init() {
		// A reactive query that triggers only when an entity's lifecycleState changes.
		this.dyingQuery = this.getQuery({
			with: [lifecycleState],
			react: [lifecycleState],
		})

		// Pre-compile payloads for the commands we will issue.
		this.addIsPooledPayload = this.compile(isPooled, {}).payload

		const { payload } = this.compile(lifecycleState, { flags: LIFECYCLE.POOLED })
		this.pooledStatePayload = payload
		this.scratchBuffer = new Uint32Array(4096) // Max chunk capacity
	}

	update({ currentTick, lastTick }) {
		for (const chunk of this.dyingQuery.iter()) {
			const states = chunk.componentData[lifecycleState]
			const changedCount = chunk.getChangedIndices(lifecycleState, lastTick, this.scratchBuffer)

			for (let i = 0; i < changedCount; i++) {
				const indexInChunk = this.scratchBuffer[i]

				// If an entity has been marked as DYING, we perform the pooling actions.
				if ((states.flags[indexInChunk] & LIFECYCLE.DYING) !== 0) {
					const entityId = chunk.entities[indexInChunk]
					this.addComponent(entityId, this.addIsPooledPayload)
					this.setComponentData(entityId, this.pooledStatePayload)
				}
			}
		}
	}
}