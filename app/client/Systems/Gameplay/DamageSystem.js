const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const {
	damageCollisionBuffer,
	damageable,
	damage,
	health,
	lifecycleState,
	hitFlash,
	hitHistory,
	immunity,
	playerTag,
} = ecs.getComponentIDs()

const { CollisionDetectionSystem } = ecs.getSystemIDs()

const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')

/**
 * Applies damage to entities based on collision events.
 * It has specialized, optimized paths for handling player damage (single-target,
 * invulnerability frames) and non-player damage (multi-target, accumulation).
 */
export class DamageSystem {
	static dependencies = {
		// Must run after collisions are detected.
		runsAfter: [CollisionDetectionSystem],
		update: {
			reads: [health, damageCollisionBuffer, lifecycleState, damage, hitFlash, immunity, playerTag], 
			writes: [health, hitHistory, immunity, hitFlash], 
		},
	}

	init() {
		// A reactive query for the player entity.
		this.playerQuery = this.getQuery({
			with: [playerTag, damageable, health, damageCollisionBuffer, lifecycleState, hitFlash, immunity],
			modified: [damageCollisionBuffer],
		})

		// A reactive query for active, non-player entities that can receive damage.
		this.receiversQuery = this.getQuery({
			with: [damageable, health, damageCollisionBuffer, lifecycleState, hitFlash],
			without: [playerTag],
			modified: [damageCollisionBuffer],
		})

		// Query for all entities that can deal damage.
		this.damagersQuery = this.getQuery({
			with: [damage, lifecycleState], // We don't need hitHistory here, we'll look it up on demand.
		})

		// Query for piercing entities to cache their hit history data.
		this.piercingDamagersQuery = this.getQuery({
			with: [hitHistory, lifecycleState],
		})

		// A cache to store damage values per entity for fast lookup in the main loop.
		// This avoids repeated, slow "remote" component lookups.
		this.damageCache = new Map()

		this.isActiveMaskId = this.getMaskId('isActive')

		// Caches for hit history data to avoid allocations and getComponent calls.
		this.hitHistoryChunkCache = new Map()
		this.hitHistoryIndexCache = new Map()

		// A set to track which chunks have had their health component modified this frame.
		this.modifiedHealthChunks = new Set()

		// --- State for allocation-free damage accumulation ---
		// These are reused in the update loop to avoid creating new objects/sets per entity.
		this.accumulatedDamage = 0
		this.damagersToUpdate = new Set()
		// State for the player-specific damage path.
		this.foundDamageValue = 0
		this.foundDamagerId = null

		this.scratchBuffer = this.createScratchBuffer()
	}

	/**
	 * The main update loop, organized into clear phases.
	 */
	update() {
		this.modifiedHealthChunks.clear()

		// --- 1. Gather Phase ---
		// Cache all relevant data from damagers to avoid lookups in the processing loops.
		this._cacheDamagerData()

		// --- 2. Scatter Phase ---
		// Process player and non-player entities in their own optimized paths.
		this._processPlayer()
		this._processReceivers()

		// --- 3. Broad-Phase Dirty Marking ---
		for (const chunkId of this.modifiedHealthChunks) {
			this.markComponentDirty(chunkId, health)
		}
	}

	/**
	 * Caches damage values and hit histories from all active damagers.
	 * This is a "gather" step to optimize the main processing loop.
	 * @private
	 */
	_cacheDamagerData() {
		this.damageCache.clear()
		const damagerChunkIds = this.damagersQuery.getChunks()
		for (let i = 0; i < damagerChunkIds.length; i++) {
			const chunkId = damagerChunkIds[i]
			const damages = this.getComponentData(chunkId, damage)
			const entities = this.getEntities(chunkId)
			const activeCount = this.getIndicesFromMask(this.isActiveMaskId, chunkId, this.scratchBuffer)
			for (let j = 0; j < activeCount; j++) {
				const indexInChunk = this.scratchBuffer[j]
				this.damageCache.set(entities[indexInChunk], damages.value[indexInChunk])
			}
		}

		this.hitHistoryChunkCache.clear()
		this.hitHistoryIndexCache.clear()
		const piercingChunkIds = this.piercingDamagersQuery.getChunks()
		for (let i = 0; i < piercingChunkIds.length; i++) {
			const chunkId = piercingChunkIds[i]
			const entities = this.getEntities(chunkId)
			const activeCount = this.getIndicesFromMask(this.isActiveMaskId, chunkId, this.scratchBuffer)
			for (let j = 0; j < activeCount; j++) {
				const indexInChunk = this.scratchBuffer[j]
				const entityId = entities[indexInChunk]
				this.hitHistoryChunkCache.set(entityId, chunkId)
				this.hitHistoryIndexCache.set(entityId, indexInChunk)
			}
		}
	}

	_processPlayer() {
		const playerChunkIds = this.playerQuery.getChunks()
		if (playerChunkIds.length === 0) return

		const playerChunkId = playerChunkIds[0]
		const changedCount = this.getDirty(
			playerChunkId,
			damageCollisionBuffer,
			this.scratchBuffer,
		)

		if (changedCount === 0) return

		const isPlayerActive = this.isBitSet(this.isActiveMaskId, playerChunkId, 0)
		const isPlayerInvulnerable = this.isComponentEnabled(playerChunkId, 0, immunity)

		if (isPlayerActive && !isPlayerInvulnerable) {
			this._applyDamageToPlayer(playerChunkId)
		}
	}

	_applyDamageToPlayer(playerChunkId) {
		this._findFirstDamager(playerChunkId)

		if (this.foundDamageValue > 0) {
			const healths = this.getComponentData(playerChunkId, health)
			healths.current[0] -= this.foundDamageValue
			this.markEntityDirty(playerChunkId, 0, health)
			this.modifiedHealthChunks.add(playerChunkId)
			this._triggerPlayerInvulnerability(playerChunkId)
			this._triggerHitFlash(this.getEntities(playerChunkId)[0], playerChunkId, 0)
		}
	}

	/**
	 * Iterates through all entities that can receive damage and processes their collision buffers.
	 * @param {number} currentTick
	 * @private
	 */
	_processReceivers() {
		const receiverChunkIds = this.receiversQuery.getChunks()
		for (let i = 0; i < receiverChunkIds.length; i++) {
			const chunkId = receiverChunkIds[i]
			// Get only the indices of entities whose collision buffer has changed.
			const changedCount = this.getDirty(
				chunkId,
				damageCollisionBuffer,
				this.scratchBuffer,
			)

			for (let j = 0; j < changedCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				// Only process entities that are currently active.
				if (this.isBitSet(this.isActiveMaskId, chunkId, indexInChunk)) {
					this._applyDamageToReceiver(chunkId, indexInChunk)
				}
			}
		}
	}

	/**
	 * Processes a single damage-receiving entity.
	 * @param {number} chunkId
	 * @param {number} indexInChunk
	 * @param {number} currentTick
	 * @private
	 */
	_applyDamageToReceiver(chunkId, indexInChunk) {
		const receiverEntityId = this.getEntities(chunkId)[indexInChunk]		

		// This method now has a side effect: it populates `this.accumulatedDamage`
		// and `this.damagersToUpdate` instead of returning a new object.
		this._accumulateDamageForReceiver(receiverEntityId, chunkId, indexInChunk)

		if (this.accumulatedDamage > 0) {
			const healths = this.getComponentData(chunkId, health)
			const newHealth = healths.current[indexInChunk] - this.accumulatedDamage

			healths.current[indexInChunk] = newHealth
			this.markEntityDirty(chunkId, indexInChunk, health)
			this.modifiedHealthChunks.add(chunkId)

			//show red tint unconditionally.
			this._triggerHitFlash(receiverEntityId, chunkId, indexInChunk)

			// Update hit history for all damagers that landed a hit.
			for (const damagerId of this.damagersToUpdate) {
				this._recordPiercingHit(damagerId, receiverEntityId)
			}
		}
	}

	/**
	 * Reads an entity's collision buffer and calculates total damage from valid damagers.
	 * This method has a side effect: it populates `this.accumulatedDamage` and `this.damagersToUpdate`.
	 * @private
	 */
	_accumulateDamageForReceiver(receiverEntityId, chunkId, indexInChunk) {
		// Reset the shared state for this entity.
		this.accumulatedDamage = 0
		this.damagersToUpdate.clear()

		const buffers = this.getComponentData(chunkId, damageCollisionBuffer)
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
			if (this.damagersToUpdate.has(damagerEntityId) || this._isPiercingHitInvalid(damagerEntityId, receiverEntityId)) {
				continue
			}

			const damageValue = this.damageCache.get(damagerEntityId)
			if (damageValue > 0) {
				this.accumulatedDamage += damageValue
				this.damagersToUpdate.add(damagerEntityId)
			}
		}
	}
	
	_findFirstDamager(playerChunkId) {
		this.foundDamageValue = 0
		this.foundDamagerId = null

		const buffers = this.getComponentData(playerChunkId, damageCollisionBuffer)
		const collisionCount = buffers.count[0]

		for (let i = 0; i < collisionCount; i++) {
			let damagerId
			switch (i) {
				case 0: damagerId = buffers.event0[0]; break
				case 1: damagerId = buffers.event1[0]; break
				case 2: damagerId = buffers.event2[0]; break
				case 3: damagerId = buffers.event3[0]; break
				case 4: damagerId = buffers.event4[0]; break
				case 5: damagerId = buffers.event5[0]; break
				case 6: damagerId = buffers.event6[0]; break
				case 7: damagerId = buffers.event7[0]; break
			}

			const damageValue = this.damageCache.get(damagerId)
			if (damageValue > 0) {
				this.foundDamageValue = damageValue
				this.foundDamagerId = damagerId
				return
			}
		}
	}

	_triggerPlayerInvulnerability(playerChunkId) {
		const immunities = this.getComponentData(playerChunkId, immunity)
		immunities.timer[0] = immunities.duration[0]
		this.enableComponent(playerChunkId, 0, immunity)
	}

	/**
	 * Issues commands to enable an entity's hitFlash component and set its timer.
	 * @private
	 */
	_triggerHitFlash(receiverEntityId, chunkId, indexInChunk) {
		const hitFlashes = this.getComponentData(chunkId, hitFlash)

		hitFlashes.timer[indexInChunk] = hitFlashes.duration[indexInChunk]
		this.enableComponent(chunkId, indexInChunk, hitFlash)
	}

	/**
	 * For piercing projectiles, checks if the projectile has already hit the receiver.
	 * For non-piercing damagers, this always returns false.
	 * @private
	 */
	_isPiercingHitInvalid(damagerId, receiverId) {
		const historyChunkId = this.hitHistoryChunkCache.get(damagerId)
		if (!historyChunkId) {
			// This is not a piercing projectile, so it can't have a "hit history".
			return false // It can hit.
		}

		const indexInChunk = this.hitHistoryIndexCache.get(damagerId)
		const histories = this.getComponentData(historyChunkId, hitHistory)
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
	 * If a damager is a piercing projectile, this adds the receiver's ID to its hit history.
	 * @private
	 */
	_recordPiercingHit(damagerId, receiverId) {
		const historyChunkId = this.hitHistoryChunkCache.get(damagerId)
		if (!historyChunkId) {
			return // Does not have the component.
		}

		const indexInChunk = this.hitHistoryIndexCache.get(damagerId)
		const histories = this.getComponentData(historyChunkId, hitHistory)
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

		this.markEntityDirty(historyChunkId, indexInChunk, hitHistory)
	}
}
