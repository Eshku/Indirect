const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const {
	damageCollisionBuffer,
	damageable,
	damage,
	health,
	isPooled,
	lifecycleState,
	hitFlash,
	hitHistory,
	immunity,
	playerTag,
} = ecs.getComponentIDs()

const { CollisionDetectionSystem } = ecs.getSystemIDs()

const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')

/**
 * Applies damage to entities based on collision events.
 * It reads the CollisionBuffer of entities that can deal damage and,
 * for each collision, reduces the health of the target entity.
 * This system iterates over entities that can *receive* damage, checks their collision
 * buffer, and accumulates damage from any colliding entities that have a `Damage` component.
 */
export class DamageSystem {
	static dependencies = {
		// Must run after CollisionSystem populates the buffers.
		runsAfter: [CollisionDetectionSystem],
		update: {
			reads: [health, damageCollisionBuffer, lifecycleState, damage, hitFlash, immunity, playerTag], // damageCollisionBuffer is still read, but the query is now reactive
			writes: [health, hitHistory, immunity, hitFlash], // This system modifies health, history, and can enable invuln/hitflash.
		},
	}

	init() {
		// Query for active entities that can receive damage.
		// Since all damageable entities (including the player) now have `hitFlash`,
		// we can simplify the query to require it.
		this.receiversQuery = this.getQuery({
			with: [damageable, health, damageCollisionBuffer, lifecycleState, hitFlash],
			without: [isPooled],
			modified: [damageCollisionBuffer], // Only process entities whose collision buffer has changed.
		})

		// Query for all entities that can deal damage.
		this.damagersQuery = this.getQuery({
			with: [damage], // We don't need hitHistory here, we'll look it up on demand.
			without: [isPooled],
		})

		// A single query for the player to get their ID and immunity state.
		this.playerQuery = this.getQuery({ with: [playerTag, immunity] })
		this.playerId = this.playerQuery.getSingleEntity()
		this.isPlayerInvulnerable = false // A cache for the player's state, updated each frame.

		// Query for piercing entities to cache their hit history data.
		this.piercingDamagersQuery = this.getQuery({
			with: [hitHistory],
			without: [isPooled],
		})

		// A cache to store damage values per entity for fast lookup in the main loop.
		// This avoids repeated, slow "remote" component lookups.
		this.damageCache = new Map()

		// Caches for hit history data to avoid allocations and getComponent calls.
		this.hitHistoryChunkCache = new Map()
		this.hitHistoryIndexCache = new Map()

		// --- State for allocation-free damage accumulation ---
		// These are reused in the update loop to avoid creating new objects/sets per entity.
		this.accumulatedDamage = 0
		this.damagersToUpdate = new Set()
		this.scratchBuffer = this.getScratchBuffer(damageCollisionBuffer)
	}

	/**
	 * The main update loop, organized into clear phases.
	 */
	update({ currentTick, lastTick }) {
		// --- 1. Gather Phase ---
		// Cache all relevant data from damagers and the player to avoid lookups in the main loop.
		this._cacheDamagerData()
		this._cachePlayerState()

		// --- 2. Scatter Phase ---
		// Iterate through entities that can receive damage and apply it.
		this._processReceivers(currentTick, lastTick)
	}

	/**
	 * Caches damage values and hit histories from all active damagers.
	 * This is a "gather" step to optimize the main processing loop.
	 * @private
	 */
	_cacheDamagerData() {
		this.damageCache.clear()
		for (const chunk of this.damagersQuery.iter()) {
			const damages = chunk.componentData[damage]
			for (let i = 0; i < chunk.size; i++) {
				this.damageCache.set(chunk.entities[i], damages.value[i])
			}
		}

		this.hitHistoryChunkCache.clear()
		this.hitHistoryIndexCache.clear()
		for (const chunk of this.piercingDamagersQuery.iter()) {
			for (let i = 0; i < chunk.size; i++) {
				const entityId = chunk.entities[i]
				// Cache the chunk and index for zero-allocation access later.
				this.hitHistoryChunkCache.set(entityId, chunk)
				this.hitHistoryIndexCache.set(entityId, i)
			}
		}
	}

	/**
	 * Caches the player's current invulnerability state.
	 * @private
	 */
	_cachePlayerState() {
		this.isPlayerInvulnerable = false
		const playerChunk = this.playerQuery.getSingleChunk()
		this.isPlayerInvulnerable = playerChunk.isComponentEnabled(0, immunity)
	}

	/**
	 * Iterates through all entities that can receive damage and processes their collision buffers.
	 * @param {number} currentTick
	 * @private
	 */
	_processReceivers(currentTick, lastTick) {
		for (const chunk of this.receiversQuery.iter()) {
			const states = chunk.componentData[lifecycleState]
			// Get only the indices of entities whose collision buffer has changed.
			const changedCount = chunk.getChangedIndices(damageCollisionBuffer, lastTick, this.scratchBuffer)

			for (let i = 0; i < changedCount; i++) {
				const indexInChunk = this.scratchBuffer[i]

				// Only process entities that are currently active.
				if ((states.flags[indexInChunk] & LIFECYCLE.ACTIVE) !== 0) {
					this._applyDamageToReceiver(chunk, indexInChunk, currentTick)
				}
			}
		}
	}

	/**
	 * Processes a single damage-receiving entity.
	 * @param {import('@managers/QueryManager/ChunkView.js').ChunkView} chunk
	 * @param {number} indexInChunk
	 * @param {number} currentTick
	 * @private
	 */
	_applyDamageToReceiver(chunk, indexInChunk, currentTick) {
		const receiverEntityId = chunk.entities[indexInChunk]
		const isPlayer = receiverEntityId === this.playerId

		// Early exit for invulnerable player.
		if (isPlayer && this.isPlayerInvulnerable) {
			return
		}

		// This method now has a side effect: it populates `this.accumulatedDamage`
		// and `this.damagersToUpdate` instead of returning a new object.
		this._accumulateDamage(receiverEntityId, chunk, indexInChunk, isPlayer)

		if (this.accumulatedDamage > 0) {
			const healths = chunk.componentData[health]
			const newHealth = healths.current[indexInChunk] - this.accumulatedDamage

			// Direct Write: Update health directly in the component array. This is much faster
			// than using the command buffer via `setComponentData`.
			healths.current[indexInChunk] = newHealth
			// Mark Dirty: Manually notify the engine of the change for reactive systems (like HealthSystem).
			chunk.markEntityDirty(indexInChunk, health, currentTick)

			// Trigger player-specific effects.
			if (isPlayer) {
				this._triggerPlayerInvulnerability(chunk, indexInChunk)
				// Instantly update the local cache to prevent further damage within this same frame.
				this.isPlayerInvulnerable = true
			}

			//show ret tint unconditionally.
			this._triggerHitFlash(chunk, indexInChunk)

			// Update hit history for all damagers that landed a hit.
			for (const damagerId of this.damagersToUpdate) {
				this._addHitToHistory(damagerId, receiverEntityId, currentTick)
			}
		}
	}

	/**
	 * Reads an entity's collision buffer and calculates total damage from valid damagers.
	 * This method has a side effect: it populates `this.accumulatedDamage` and `this.damagersToUpdate`.
	 * @private
	 */
	_accumulateDamage(receiverEntityId, chunk, indexInChunk, isPlayer) {
		// Reset the shared state for this entity.
		this.accumulatedDamage = 0
		this.damagersToUpdate.clear()

		const buffers = chunk.componentData[damageCollisionBuffer]
		const collisionCount = buffers.count[indexInChunk]

		if (collisionCount === 0) {
			return // No damage to accumulate.
		}
		// This loop avoids allocating a temporary array for the events,
		// using a switch for maximum performance.
		for (let j = 0; j < collisionCount; j++) {
			let damagerEntityId
			switch (j) {
				case 0:
					damagerEntityId = buffers.event0[indexInChunk]
					break
				case 1:
					damagerEntityId = buffers.event1[indexInChunk]
					break
				case 2:
					damagerEntityId = buffers.event2[indexInChunk]
					break
				case 3:
					damagerEntityId = buffers.event3[indexInChunk]
					break
				case 4:
					damagerEntityId = buffers.event4[indexInChunk]
					break
				case 5:
					damagerEntityId = buffers.event5[indexInChunk]
					break
				case 6:
					damagerEntityId = buffers.event6[indexInChunk]
					break
				case 7:
					damagerEntityId = buffers.event7[indexInChunk]
					break
			}

			// Skip if we've already processed this damager for this receiver this frame,
			// or if the damager's hit history shows it already hit this receiver.
			if (this.damagersToUpdate.has(damagerEntityId) || this._hasAlreadyHit(damagerEntityId, receiverEntityId)) {
				continue
			}

			const damageValue = this.damageCache.get(damagerEntityId)
			if (damageValue > 0) {
				this.accumulatedDamage += damageValue
				this.damagersToUpdate.add(damagerEntityId)

				if (isPlayer) {
					// For the player, only apply the first valid source of damage per frame and stop.
					return
				}
			}
		}
	}

	/**
	 * Issues commands to enable the player's invulnerability component and set its timer.
	 * @private
	 */
	_triggerPlayerInvulnerability(playerChunk, indexInChunk) {
		const immunities = playerChunk.componentData[immunity]

		// Set the timer to its max duration and enable the component.
		immunities.timer[indexInChunk] = immunities.duration[indexInChunk]

		// Direct Write: Enable the component immediately. This avoids the one-tick delay
		// of the command buffer, ensuring InvulnerabilitySystem sees the change in the same tick.
		playerChunk.enableComponent(indexInChunk, immunity)
	}

	/**
	 * Issues commands to enable an entity's hitFlash component and set its timer.
	 * @private
	 */
	_triggerHitFlash(chunk, indexInChunk) {
		const hitFlashes = chunk.componentData[hitFlash]

		hitFlashes.timer[indexInChunk] = hitFlashes.duration[indexInChunk]

		chunk.enableComponent(indexInChunk, hitFlash)
	}

	/**
	 * Checks if a damager has a hitHistory component and if it contains the receiver's ID.
	 * @private
	 */
	_hasAlreadyHit(damagerId, receiverId) {
		const historyChunk = this.hitHistoryChunkCache.get(damagerId)
		if (!historyChunk) {
			// This is not a piercing projectile, so it can't have a "hit history".
			return false // It can hit.
		}

		const indexInChunk = this.hitHistoryIndexCache.get(damagerId)
		const histories = historyChunk.componentData[hitHistory]
		const count = histories.count[indexInChunk]

		if (count === 0) {
			return false
		}

		// Unroll the loop for maximum performance. This is safe because flat_array has a fixed capacity.
		// A switch with fall-through is a clean way to write this.
		switch (count) {
			default: // For any count >= 16
			case 16:
				if (histories.event15[indexInChunk] === receiverId) return true
			case 15:
				if (histories.event14[indexInChunk] === receiverId) return true
			case 14:
				if (histories.event13[indexInChunk] === receiverId) return true
			case 13:
				if (histories.event12[indexInChunk] === receiverId) return true
			case 12:
				if (histories.event11[indexInChunk] === receiverId) return true
			case 11:
				if (histories.event10[indexInChunk] === receiverId) return true
			case 10:
				if (histories.event9[indexInChunk] === receiverId) return true
			case 9:
				if (histories.event8[indexInChunk] === receiverId) return true
			case 8:
				if (histories.event7[indexInChunk] === receiverId) return true
			case 7:
				if (histories.event6[indexInChunk] === receiverId) return true
			case 6:
				if (histories.event5[indexInChunk] === receiverId) return true
			case 5:
				if (histories.event4[indexInChunk] === receiverId) return true
			case 4:
				if (histories.event3[indexInChunk] === receiverId) return true
			case 3:
				if (histories.event2[indexInChunk] === receiverId) return true
			case 2:
				if (histories.event1[indexInChunk] === receiverId) return true
			case 1:
				if (histories.event0[indexInChunk] === receiverId) return true
		}

		return false // Not in the history.
	}

	/**
	 * Adds a receiver's ID to a damager's hitHistory buffer via a direct write.
	 * @private
	 */
	_addHitToHistory(damagerId, receiverId, currentTick) {
		const historyChunk = this.hitHistoryChunkCache.get(damagerId)
		if (!historyChunk) {
			return // Does not have the component.
		}

		const indexInChunk = this.hitHistoryIndexCache.get(damagerId)
		const histories = historyChunk.componentData[hitHistory]
		const count = histories.count[indexInChunk]
		const capacity = histories.capacity[indexInChunk]

		if (count >= capacity) {
			return // Buffer is full.
		}

		// Direct Write: Update the component data in-place.
		const newIndex = count
		histories.count[indexInChunk] = count + 1
		switch (newIndex) {
			case 0:
				histories.event0[indexInChunk] = receiverId
				break
			case 1:
				histories.event1[indexInChunk] = receiverId
				break
			case 2:
				histories.event2[indexInChunk] = receiverId
				break
			case 3:
				histories.event3[indexInChunk] = receiverId
				break
			case 4:
				histories.event4[indexInChunk] = receiverId
				break
			case 5:
				histories.event5[indexInChunk] = receiverId
				break
			case 6:
				histories.event6[indexInChunk] = receiverId
				break
			case 7:
				histories.event7[indexInChunk] = receiverId
				break
			case 8:
				histories.event8[indexInChunk] = receiverId
				break
			case 9:
				histories.event9[indexInChunk] = receiverId
				break
			case 10:
				histories.event10[indexInChunk] = receiverId
				break
			case 11:
				histories.event11[indexInChunk] = receiverId
				break
			case 12:
				histories.event12[indexInChunk] = receiverId
				break
			case 13:
				histories.event13[indexInChunk] = receiverId
				break
			case 14:
				histories.event14[indexInChunk] = receiverId
				break
			case 15:
				histories.event15[indexInChunk] = receiverId
				break
		}

		historyChunk.markEntityDirty(indexInChunk, hitHistory, currentTick)
	}
}
