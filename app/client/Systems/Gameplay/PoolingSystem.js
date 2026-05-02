const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { lifecycleState, isPooled, tint, hitFlash, playerProjectile, visibility } = ecs.getComponentIDs()

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
		// Query for dying entities that are "living" things which can be damaged and show a hit flash.
		this.dyingDamageablesQuery = this.getQuery({
			with: [lifecycleState, tint, hitFlash, visibility],
			modified: [lifecycleState],
		})

		// Query for dying projectiles. They don't have hitFlash.
		this.dyingProjectilesQuery = this.getQuery({
			with: [lifecycleState, tint, playerProjectile, visibility],
			without: [hitFlash], // Explicitly exclude entities with hitFlash
			modified: [lifecycleState],
		})

		// --- Payloads ---
		this.addIsPooledPayload = this.compile({ isPooled: {} })

		// Payload for resetting damageable entities (e.g., enemies).
		// We set their state to POOLED, reset their tint, and make them invisible.
		this.pooledDamageableResetPayload = this.compile({
			lifecycleState: { flags: LIFECYCLE.POOLED },
			tint: {}, // Reset to schema default (white)
			visibility: { isVisible: 0 },
		})

		// Payload for resetting projectiles.
		// We set their state to POOLED and make them invisible.
		this.pooledProjectileResetPayload = this.compile({
			lifecycleState: { flags: LIFECYCLE.POOLED },
			visibility: { isVisible: 0 },
		})

		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ currentTick, lastTick }) {
		// Process damageable entities (enemies, player)
		const dyingDamageableChunkIds = this.dyingDamageablesQuery.getChunks(lastTick, currentTick)
		for (let i = 0; i < dyingDamageableChunkIds.length; i++) {
			this._processDyingDamageableChunk(dyingDamageableChunkIds[i], lastTick, currentTick)
		}

		// Process projectiles
		const dyingProjectileChunkIds = this.dyingProjectilesQuery.getChunks(lastTick, currentTick)
		for (let i = 0; i < dyingProjectileChunkIds.length; i++) {
			this._processDyingProjectileChunk(dyingProjectileChunkIds[i], lastTick, currentTick)
		}
	}

	_processDyingDamageableChunk(chunkId, lastTick, currentTick) {
		const states = this.getComponentData(chunkId, lifecycleState)
		const entities = this.getEntities(chunkId)
		const changedCount = this.getDirty(chunkId, lifecycleState, lastTick, currentTick, this.scratchBuffer)

		for (let i = 0; i < changedCount; i++) {
			const indexInChunk = this.scratchBuffer[i]
			if ((states.flags[indexInChunk] & LIFECYCLE.DYING) !== 0) {
				const entityId = entities[indexInChunk]
				// Add the isPooled tag to move it to the inactive pool archetype.
				this.addComponent(entityId, this.addIsPooledPayload)
				// Set its state to POOLED, reset its tint, and make it invisible.
				this.setComponents(entityId, this.pooledDamageableResetPayload)
				// Disable the hitFlash component so it doesn't run while pooled.
				this.disableComponent(chunkId, indexInChunk, hitFlash)
			}
		}
	}

	_processDyingProjectileChunk(chunkId, lastTick, currentTick) {
		const states = this.getComponentData(chunkId, lifecycleState)
		const entities = this.getEntities(chunkId)
		const changedCount = this.getDirty(chunkId, lifecycleState, lastTick, currentTick, this.scratchBuffer)

		for (let i = 0; i < changedCount; i++) {
			const indexInChunk = this.scratchBuffer[i]
			if ((states.flags[indexInChunk] & LIFECYCLE.DYING) !== 0) {
				const entityId = entities[indexInChunk]
				this.addComponent(entityId, this.addIsPooledPayload)
				// Set state to POOLED and hide the entity.
				this.setComponents(entityId, this.pooledProjectileResetPayload)
			}
		}
	}
}
