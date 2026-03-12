const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const LIFECYCLE = ecs.componentManager.getConstantsForProperty('LifecycleState', 'flags')
const {
	playerTag,
	shootingIntent,
	playerWeaponStats,
	weaponCooldown,
	position,
	owner,
	velocity,
	distanceTraveled,
	lifecycleState,
	cursorTag,
	playerProjectile,
	isPooled,
	range,
} = ecs.getTypeIDs()

/**
 * Handles the player's firing action.
 * It reads the shooting intent, checks for cooldown, and creates a new projectile
 * entity that moves towards the cursor.
 */
export class PlayerWeaponSystem {
	static dependencies = {
		update: {
			reads: [
				// Player components
				shootingIntent,
				playerWeaponStats,
				position,
				velocity,
				weaponCooldown, // Reads the timer
				// Other entities
				cursorTag,
				lifecycleState, // For pooled orbs
			],
			writes: [weaponCooldown], // Writes to the cooldown timer
		},
	}

	init() {
		// Query for the player and all components we need to read.
		this.playerQuery = this.getQuery({
			with: [playerTag, shootingIntent, playerWeaponStats, weaponCooldown, position, velocity],
		})

		// Query for projectiles in the pool using the `isPooled` tag component.
		// This is highly efficient as it only iterates over inactive entities.
		this.pooledProjectileQuery = this.getQuery({
			with: [playerProjectile, isPooled],
		})

		// Query for the cursor singleton.
		this.cursorQuery = this.getQuery({
			with: [cursorTag, position],
		})

		// Cache singleton IDs for fast access in update().
		this.playerId = this.playerQuery.getSingleEntity()
		this.cursorId = this.cursorQuery.getSingleEntity()

		if (!this.playerId) {
			console.error('PlayerWeaponSystem: Player entity not found during initialization.')
		}
		if (!this.cursorId) {
			console.error('PlayerWeaponSystem: Cursor entity not found during initialization.')
		}

		// Pre-compile full projectile entity for maximum creation performance.
		// We will use mutators to set dynamic values (position, velocity, owner) at fire time.
		const { payload, mutators } = this.compile('playerProjectile')
		this.projectilePayload = payload
		this.projectileMutators = mutators

		// Pre-compile payloads for reactivating a pooled orb.
		const { payload: reactivatePayload, mutators: reactivateMutators } = this.compile(lifecycleState, {
			flags: LIFECYCLE.ACTIVE,
			dirtyTick: 0,
		})
		this.reactivatePayload = reactivatePayload
		this.reactivateMutators = reactivateMutators
		this.resetDistancePayload = this.compile(distanceTraveled, { value: 0 }).payload

		// Pre-compile payloads and mutators for dynamic data to be set on reactivated orbs.
		// This is the correct, performant way to handle dynamic data with commands.
		const { payload: ownerPayload, mutators: ownerMutators } = this.compile(owner)
		this.ownerPayload = ownerPayload
		this.ownerMutators = ownerMutators

		const { payload: positionPayload, mutators: positionMutators } = this.compile(position)
		this.positionPayload = positionPayload
		this.positionMutators = positionMutators

		const { payload: velocityPayload, mutators: velocityMutators } = this.compile(velocity)
		this.velocityPayload = velocityPayload
		this.velocityMutators = velocityMutators

		const { payload: rangePayload, mutators: rangeMutators } = this.compile(range)
		this.rangePayload = rangePayload
		this.rangeMutators = rangeMutators

		// Pre-compile a payload and mutator for resetting weapon cooldown.
		const { payload: cooldownPayload, mutators: cooldownMutators } = this.compile(weaponCooldown)
		this.cooldownPayload = cooldownPayload
		this.cooldownMutators = cooldownMutators
	}

	update({ currentTick }) {
		// Read components for player.
		const intent = this.getComponent(this.playerId, shootingIntent)
		const cooldown = this.getComponent(this.playerId, weaponCooldown)

		// Check for intent and if cooldown is ready.
		if (!intent || !cooldown || intent.shootingIntent !== 1 || cooldown.timer > 0) {
			return
		}

		// Now that we know we need to fire, gather all required data.
		const playerPos = this.getComponent(this.playerId, position)
		const playerVel = this.getComponent(this.playerId, velocity)
		const playerStats = this.getComponent(this.playerId, playerWeaponStats)
		const cursor = this.getComponent(this.cursorId, position)

		const fireData = {
			playerId: this.playerId,
			playerX: playerPos.x,
			playerY: playerPos.y,
			cursorX: cursor.x,
			cursorY: cursor.y,
			playerVx: playerVel.x,
			playerVy: playerVel.y,
			baseProjectileSpeed: playerStats.speed,
			inheritanceFactor: playerStats.velocityInheritance,
			projectileRange: playerStats.range,
		}

		// Calculate firing vector from player to the cursor.
		const fireDirX = fireData.cursorX - fireData.playerX
		const fireDirY = fireData.cursorY - fireData.playerY
		const fireLen = Math.sqrt(fireDirX * fireDirX + fireDirY * fireDirY)
		fireData.normFireX = fireLen > 0 ? fireDirX / fireLen : 0 // Default to no x-movement
		fireData.normFireY = fireLen > 0 ? fireDirY / fireLen : -1 // Default to firing "up" if cursor is on player

		// --- Hybrid Velocity Calculation ---
		// Project player's velocity onto firing direction vector using dot product.
		const inheritedSpeed =
			(fireData.playerVx * fireData.normFireX + fireData.playerVy * fireData.normFireY) * fireData.inheritanceFactor

		fireData.finalSpeed = Math.max(0, fireData.baseProjectileSpeed + inheritedSpeed)

		// --- Pooling Logic: Reuse first, then create ---
		const availablePooledProjectile = this.findAvailableProjectile()
		if (availablePooledProjectile) {
			this.reuseProjectile(availablePooledProjectile, fireData, currentTick)
		} else {
			this.createNewProjectile(fireData, currentTick)
		}

		// Reset cooldown using a command.
		this.cooldownMutators.weaponCooldown.timer[0] = playerStats.fireRate
		this.setComponentData(this.playerId, this.cooldownPayload)
	}

	findAvailableProjectile() {
		return this.pooledProjectileQuery.getSingleEntity()
	}

	//! pre-allocate all to get rid of branching? 1k should be enough? Might be worth testing later on
	//! Once we have upgrades and whatnot to see how much we actually pool

	reuseProjectile(entityId, fireData, currentTick) {
		this.ownerMutators.owner.entityId[0] = fireData.playerId
		this.positionMutators.position.x[0] = fireData.playerX
		this.positionMutators.position.y[0] = fireData.playerY
		this.velocityMutators.velocity.x[0] = fireData.normFireX * fireData.finalSpeed
		this.velocityMutators.velocity.y[0] = fireData.normFireY * fireData.finalSpeed
		this.rangeMutators.range.value[0] = fireData.projectileRange

		this.reactivateMutators.lifecycleState.dirtyTick[0] = currentTick + 1
		// This is the structural change to bring the entity back into the "active" world.
		this.removeComponent(entityId, isPooled)

		// These commands update the entity's state for its new life.
		// Align all to happen at the next frame with remove Component command.
		this.setComponentData(entityId, this.reactivatePayload) // Sets lifecycle to ACTIVE
		this.setComponentData(entityId, this.resetDistancePayload)
		this.setComponentData(entityId, this.ownerPayload)
		this.setComponentData(entityId, this.positionPayload)
		this.setComponentData(entityId, this.velocityPayload)
		this.setComponentData(entityId, this.rangePayload)
	}

	createNewProjectile(fireData, currentTick) {
		this.projectileMutators.owner.entityId[0] = fireData.playerId
		this.projectileMutators.position.x[0] = fireData.playerX
		this.projectileMutators.position.y[0] = fireData.playerY
		this.projectileMutators.velocity.x[0] = fireData.normFireX * fireData.finalSpeed
		this.projectileMutators.velocity.y[0] = fireData.normFireY * fireData.finalSpeed
		this.projectileMutators.range.value[0] = fireData.projectileRange

		this.projectileMutators.lifecycleState.dirtyTick[0] = currentTick + 1 //! technically redundent, mostly for consistency

		this.projectileMutators.spriteDescriptor.dirtyTick[0] = currentTick + 1

		this.createEntity(this.projectilePayload)
	}
}
