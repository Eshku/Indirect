const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { lifecycleState, isPooled, tint, hitFlash, playerProjectile } = ecs.getTypeIDs()

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
			reads: [lifecycleState],
			writes: [lifecycleState, isPooled],
		},
	}

	init() {
		// Query for dying entities that have hitFlash (e.g., enemies).
		this.dyingWithHitFlashQuery = this.getQuery({
			with: [lifecycleState, tint, hitFlash], // Ensure hitFlash exists
			modified: [lifecycleState],
		})

		// Query for dying entities that do NOT have hitFlash (e.g., projectiles).
		this.dyingWithoutHitFlashQuery = this.getQuery({
			with: [lifecycleState, tint], // Projectiles have tint
			without: [hitFlash], // Explicitly exclude entities with hitFlash
			modified: [lifecycleState],
		})

		// --- Payloads ---
		this.addIsPooledPayload = this.compile(isPooled, {}).payload
		this.pooledStatePayload = this.compile(lifecycleState, { flags: LIFECYCLE.POOLED }).payload

		// Payload for resetting entities WITH hitFlash.
		this.resetWithHitFlashPayload = this.compile({ tint: { r: 1.0, g: 1.0, b: 1.0 }, hitFlash: { duration: 0.0 } }).payload

		// Payload for resetting entities WITHOUT hitFlash.
		this.resetWithoutHitFlashPayload = this.compile({ tint: { r: 1.0, g: 1.0, b: 1.0 } }).payload

		this.scratchBuffer = this.getScratchBuffer(lifecycleState)
	}

	update({ currentTick, lastTick }) {
		// Process entities that have hitFlash (enemies)
		for (const chunk of this.dyingWithHitFlashQuery.iter()) {
			this._processDyingChunk(chunk, lastTick, true)
		}

		// Process entities that do NOT have hitFlash (projectiles)
		for (const chunk of this.dyingWithoutHitFlashQuery.iter()) {
			this._processDyingChunk(chunk, lastTick, false)
		}
	}

	_processDyingChunk(chunk, lastTick, hasHitFlash) {
		const states = chunk.componentData[lifecycleState]
		const changedCount = chunk.getChangedIndices(lifecycleState, lastTick, this.scratchBuffer)

		for (let i = 0; i < changedCount; i++) {
			const indexInChunk = this.scratchBuffer[i]
			if ((states.flags[indexInChunk] & LIFECYCLE.DYING) !== 0) {
				const entityId = chunk.entities[indexInChunk]

				// Common commands for all pooled entities
				this.addComponent(entityId, this.addIsPooledPayload)
				this.setComponentData(entityId, this.pooledStatePayload)

				// Specific commands based on whether it has hitFlash
				if (hasHitFlash) {
					this.setComponentsData(entityId, this.resetWithHitFlashPayload)
					this.disableComponent(entityId, hitFlash) 
				} else {
					this.setComponentsData(entityId, this.resetWithoutHitFlashPayload)
				}
			}
		}
	}
}