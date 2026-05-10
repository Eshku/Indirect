const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const { stringInterningTable } = await import(`@client/Indirect/StringInterningTable.js`)

const {
	lifecycleState,
	scale,
	tint,
	visibility,
	triggersOnDeath,
	position,
	areaOfEffectDamage,
	explosiveDroneTag,
	lifetime,
	explosionEffectTag,
} = ecs.getComponentIDs()

const { SyncTransforms } = ecs.getSystemIDs()
const { Easing } = await import(`@core/utils/easing.js`)

const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')

const EXPLOSION_PREFAB_NAME = 'smallExplosionEffect'
const MAX_EXPLOSIONS_PER_FRAME = 100
const EXPLOSIVE_DRONE_INFLATION_SCALE = 2.5 // Inflates to 250% of original size

export class DeathAnimationSystem {
	static runsBefore = [SyncTransforms]

	static dependencies = {
		update: {
			reads: [lifecycleState, position, triggersOnDeath, areaOfEffectDamage, lifetime],
			writes: [lifecycleState, scale, tint, visibility], // Also issues instantiate commands
		},
	}

	init() {
		// Get mask IDs for lifecycle states
		this.isDyingMaskId = this.getMaskId('isDying')
		this.isDeadMaskId = this.getMaskId('isDead')
		this.isPooledMaskId = this.getMaskId('isPooled')
		this.isActiveMaskId = this.getMaskId('isActive')

		this.query = this.getQuery({
			with: [lifecycleState, scale, tint, visibility, position],
		})

		this.scratchBuffer = this.createScratchBuffer()

		// --- Explosion Pooling & Creation ---
		this.pooledExplosionQuery = this.getQuery({
			with: [explosionEffectTag, lifecycleState], // Use the specific tag for pooling
		})

		this.availablePooledExplosions = []

		// Pre-compile the payload for creating NEW explosion effects.
		this.explosionPayload = this.compile(EXPLOSION_PREFAB_NAME, {
			count: MAX_EXPLOSIONS_PER_FRAME,
			overrides: {
				position: {}, // We will set this at runtime.
			},
		})
		this.explosionMutators = this.explosionPayload.buffers

		// A counter for batching NEW explosion spawns.
		this.explosionsToSpawnCount = 0

		// A set to track which chunks have had their components modified this frame for reuse.
		this.modifiedChunksForReactiveSystems = new Set()
	}

	update({ deltaTime, currentTick }) {
		// Reset the new-spawn batch counter for this frame.
		this.explosionsToSpawnCount = 0
		this.modifiedChunksForReactiveSystems.clear()

		// Gather all available pooled explosions for this frame.
		this._gatherPooledExplosions()

		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const states = this.getComponentData(chunkId, lifecycleState) // Still needed for timer/duration
			const isExplosiveChunk = !!this.getComponentData(chunkId, explosiveDroneTag)

			let wasScaleChunkModified = false
			let wasStateChunkModified = false
			let wasTintChunkModified = false
			let wasVisibilityChunkModified = false

			const dyingCount = this.getIndicesFromMask(this.isDyingMaskId, chunkId, this.scratchBuffer)

			for (let j = 0; j < dyingCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				// If duration is 0, it's an instant death. Transition immediately.
				if (states.duration[indexInChunk] <= 0) {
					this._transitionToDead(chunkId, indexInChunk, currentTick)
					wasStateChunkModified = true
					wasVisibilityChunkModified = true
					wasScaleChunkModified = true
					wasTintChunkModified = true
					continue
				}

				const newTime = Math.max(0, states.timer[indexInChunk] - deltaTime)
				states.timer[indexInChunk] = newTime

				// Progress goes from 0 to 1 as timer goes from duration to 0
				const progress = 1.0 - newTime / states.duration[indexInChunk]
				const scales = this.getComponentData(chunkId, scale)
				const tints = this.getComponentData(chunkId, tint)

				if (isExplosiveChunk) {
					// Inflate animation for explosive drones
					const easedProgress = Easing.easeInQuad(progress)
					const newScale = 1.0 + easedProgress * (EXPLOSIVE_DRONE_INFLATION_SCALE - 1.0)
					scales.x[indexInChunk] = newScale
					scales.y[indexInChunk] = newScale

					// Tint to white/red to signal explosion
					tints.g[indexInChunk] = 1.0 - easedProgress
					tints.b[indexInChunk] = 1.0 - easedProgress
				} else {
					// Original scale down and fade out animation
					const newScale = 1.0 - progress
					scales.x[indexInChunk] = newScale
					scales.y[indexInChunk] = newScale
					tints.a[indexInChunk] = newScale
				}

				this.markEntityDirty(chunkId, indexInChunk, scale, currentTick)
				this.markEntityDirty(chunkId, indexInChunk, tint, currentTick)
				wasScaleChunkModified = true
				wasTintChunkModified = true

				if (newTime <= 0) {
					this._transitionToDead(chunkId, indexInChunk, currentTick)
					wasStateChunkModified = true
					wasVisibilityChunkModified = true
					wasTintChunkModified = true
					wasScaleChunkModified = true
				}
			}

			if (wasScaleChunkModified) this.markComponentDirty(chunkId, scale, currentTick)
			if (wasTintChunkModified) this.markComponentDirty(chunkId, tint, currentTick)
			if (wasStateChunkModified) this.markComponentDirty(chunkId, lifecycleState, currentTick)
			if (wasVisibilityChunkModified) this.markComponentDirty(chunkId, visibility, currentTick)
		}

		// After iterating all chunks, instantiate the batched explosions.
		if (this.explosionsToSpawnCount > 0) {
			this.instantiate(this.explosionPayload, this.explosionsToSpawnCount)
		}

		// After processing, mark the chunks containing reused explosions as dirty for reactive systems.
		for (const chunkId of this.modifiedChunksForReactiveSystems) {
			this.markComponentDirty(chunkId, lifecycleState, currentTick)
			this.markComponentDirty(chunkId, tint, currentTick)
			this.markComponentDirty(chunkId, visibility, currentTick)
		}
	}

	/**
	 * Gathers all available pooled explosion entities into an array for reuse this frame.
	 * @private
	 */
	_gatherPooledExplosions() {
		this.availablePooledExplosions.length = 0
		const chunkIds = this.pooledExplosionQuery.getChunks()
		for (const chunkId of chunkIds) {
			const entities = this.getEntities(chunkId)
			const pooledCount = this.getIndicesFromMask(this.isPooledMaskId, chunkId, this.scratchBuffer)
			for (let i = 0; i < pooledCount; i++) {
				const indexInChunk = this.scratchBuffer[i]
				this.availablePooledExplosions.push(entities[indexInChunk])
			}
		}
	}

	/**
	 * Handles the logic for transitioning an entity to the DEAD state, including
	 * triggering death effects and resetting component data for pooling.
	 * @private
	 */
	_transitionToDead(chunkId, indexInChunk, currentTick) {
		const deathTriggers = this.getComponentData(chunkId, triggersOnDeath)
		const positions = this.getComponentData(chunkId, position)

		// If the entity has a death trigger, add it to our spawn batch.
		if (deathTriggers) {
			const prefabRef = deathTriggers.prefabRef[indexInChunk]

			const effectPrefabName = stringInterningTable.get(prefabRef)
			if (effectPrefabName === EXPLOSION_PREFAB_NAME && this.explosionsToSpawnCount < MAX_EXPLOSIONS_PER_FRAME) {
				const posX = positions.x[indexInChunk]
				const posY = positions.y[indexInChunk]
				// Prioritize reusing a pooled explosion.
				if (this.availablePooledExplosions.length > 0) {
					const explosionId = this.availablePooledExplosions.pop()
					this._reuseExplosion(explosionId, posX, posY, currentTick)
				} else if (this.explosionsToSpawnCount < MAX_EXPLOSIONS_PER_FRAME) {
					// Fallback to creating a new one if the pool is empty.
					const spawnIndex = this.explosionsToSpawnCount++
					this.explosionMutators.position.x[spawnIndex] = posX
					this.explosionMutators.position.y[spawnIndex] = posY
				}
			}
		}

		// Transition from DYING to DEAD
		this.clearBit(this.isDyingMaskId, chunkId, indexInChunk)
		this.setBit(this.isDeadMaskId, chunkId, indexInChunk)

		const states = this.getComponentData(chunkId, lifecycleState)
		const scales = this.getComponentData(chunkId, scale)
		const visibilities = this.getComponentData(chunkId, visibility)
		const tints = this.getComponentData(chunkId, tint)

		states.state[indexInChunk] = LIFECYCLE.DEAD

		// Final state: invisible, full alpha (for reuse), default tint, and default scale.
		scales.x[indexInChunk] = 1.0
		scales.y[indexInChunk] = 1.0
		visibilities.isVisible[indexInChunk] = 0
		tints.r[indexInChunk] = 1.0
		tints.g[indexInChunk] = 1.0
		tints.b[indexInChunk] = 1.0
		tints.a[indexInChunk] = 1.0

		this.markEntityDirty(chunkId, indexInChunk, lifecycleState, currentTick)
		this.markEntityDirty(chunkId, indexInChunk, visibility, currentTick)
		this.markEntityDirty(chunkId, indexInChunk, tint, currentTick)
		this.markEntityDirty(chunkId, indexInChunk, scale, currentTick)
	}

	/**
	 * Resets a pooled explosion entity for immediate reuse using direct component writes.
	 * @private
	 */
	_reuseExplosion(entityId, newX, newY, currentTick) {
		const location = this.getEntityLocation(entityId)
		if (!location) return
		const { chunkId, indexInChunk } = location

		const states = this.getComponentData(chunkId, lifecycleState)
		const visibilities = this.getComponentData(chunkId, visibility)
		const positions = this.getComponentData(chunkId, position)
		const aoeDatas = this.getComponentData(chunkId, areaOfEffectDamage)
		const lifetimes = this.getComponentData(chunkId, lifetime)

		// Reset state for reuse
		// Manually flip the state bits for this reused entity.
		this.clearBit(this.isPooledMaskId, chunkId, indexInChunk)
		this.setBit(this.isActiveMaskId, chunkId, indexInChunk)

		states.state[indexInChunk] = LIFECYCLE.ACTIVE
		visibilities.isVisible[indexInChunk] = 1
		positions.x[indexInChunk] = newX
		positions.y[indexInChunk] = newY
		aoeDatas.hasApplied[indexInChunk] = 0
		lifetimes.timer[indexInChunk] = lifetimes.duration[indexInChunk] // Reset timer to its full duration

		// Mark trackable components as dirty for same-frame reactivity.
		// Narrow-phase marking for specific entities.
		this.markEntitiesDirtyById(entityId, [lifecycleState, visibility, tint], currentTick)
		// Broad-phase marking for the chunk, so reactive systems pick it up.
		this.modifiedChunksForReactiveSystems.add(chunkId)
	}
}
