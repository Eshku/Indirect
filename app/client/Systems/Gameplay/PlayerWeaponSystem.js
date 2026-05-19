const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

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
	rotation,
	playerProjectile,
	range,
	damage,
	hitHistory,
	viewable,
	visibility,
	spriteDescriptor,
	layer,
} = ecs.getComponentIDs()

const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')

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
			with: [playerTag, shootingIntent, playerWeaponStats, weaponCooldown, position],
		})

		// Query for projectiles in the pool.
		this.pooledProjectileQuery = this.getQuery({
			with: [playerProjectile, lifecycleState],
		})

		// Query for the cursor singleton.
		this.cursorQuery = this.getQuery({
			with: [cursorTag, position],
		})

		this.isPooledMaskId = this.getMaskId('isPooled')
		this.isActiveMaskId = this.getMaskId('isActive')
		this.scratchBuffer = this.createScratchBuffer()

		// Cache singleton IDs for fast access in update().
		this.playerId = this.playerQuery.getSingleEntity()
		this.cursorId = this.cursorQuery.getSingleEntity()

		// Pre-compile full projectile entity for maximum creation performance.
		// We will use mutators to set dynamic values (position, velocity, owner) at fire time.
		this.projectilePayload = this.compile('slashingArc')
		this.projectileMutators = this.projectilePayload.buffers
	}

	update() {
		let intentValue, cooldownTimer, playerX, playerY, playerStats, cursorX, cursorY

		const playerChunkIds = this.playerQuery.getChunks()

		const playerChunkId = playerChunkIds[0]
		// player is guarantied to be present.

		const shootingIntents = this.getComponentData(playerChunkId, shootingIntent)
		const cooldowns = this.getComponentData(playerChunkId, weaponCooldown)
		const positions = this.getComponentData(playerChunkId, position)
		intentValue = shootingIntents.shootingIntent[0]
		cooldownTimer = cooldowns.timer[0]
		playerX = positions.x[0]
		playerY = positions.y[0]
		playerStats = this.getComponentData(playerChunkId, playerWeaponStats) // Keep SoA object for multiple property access

		// Check for intent and if cooldown is ready.
		if (intentValue !== 1 || cooldownTimer > 0) {
			return
		}

		const cursorChunkIds = this.cursorQuery.getChunks()
		const cursorChunkId = cursorChunkIds[0]
		// cursor is guarantied to be present.

		const cursorPositions = this.getComponentData(cursorChunkId, position)
		cursorX = cursorPositions.x[0]
		cursorY = cursorPositions.y[0]

		const fireData = {
			playerId: this.playerId,
			playerX: playerX,
			playerY: playerY,
			cursorX: cursorX,
			cursorY: cursorY,
			baseProjectileSpeed: playerStats.speed[0],
			projectileRange: playerStats.range[0],
			projectileDamage: playerStats.damage[0],
			angle: 0,
			spawnX: 0,
			spawnY: 0,
		}

		// Calculate firing vector from player to the cursor.
		const fireDirX = fireData.cursorX - fireData.playerX
		const fireDirY = fireData.cursorY - fireData.playerY
		const fireLen = Math.sqrt(fireDirX * fireDirX + fireDirY * fireDirY)
		fireData.normFireX = fireLen > 0 ? fireDirX / fireLen : 0 // Default to no x-movement
		fireData.normFireY = fireLen > 0 ? fireDirY / fireLen : -1 // Default to firing "up" if cursor is on player

		// The angle of the aim direction.
		// We use atan2(y, x) to get the angle. However, in many 2D game engines,
		// the Y-axis points down, whereas the mathematical `atan2` function assumes Y points up.
		// This can cause rotations to feel "reversed" when aiming vertically.
		// By negating the Y component, we align the angle calculation with the visual coordinate system.
		const aimAngle = Math.atan2(-fireData.normFireY, fireData.normFireX)
		// The slash rotation should be perpendicular to the aim direction. We add 90 degrees (PI/2 radians).
		fireData.angle = aimAngle + Math.PI / 2

		const PROJECTILE_SPAWN_OFFSET = 64 // Half the projectile's depth (128/2) to spawn it at the player's edge.
		fireData.spawnX = fireData.playerX + fireData.normFireX * PROJECTILE_SPAWN_OFFSET
		fireData.spawnY = fireData.playerY + fireData.normFireY * PROJECTILE_SPAWN_OFFSET

		fireData.finalSpeed = fireData.baseProjectileSpeed

		const availablePooledProjectile = this.findAvailableProjectile()

		if (availablePooledProjectile) {
			this.reuseProjectile(availablePooledProjectile, fireData)
		} else {
			this.createNewProjectile(fireData)
		}

		// Reset cooldown using direct writes for better performance and immediate effect.
		cooldowns.timer[0] = playerStats.fireRate[0]
		this.enableComponentById(this.playerId, weaponCooldown)
	}

	findAvailableProjectile() {
		const chunkIds = this.pooledProjectileQuery.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const pooledCount = this.getIndicesFromMask(this.isPooledMaskId, chunkId, this.scratchBuffer)
			if (pooledCount > 0) {
				// Return the first one we find.
				const indexInChunk = this.scratchBuffer[0]
				return this.getEntities(chunkId)[indexInChunk]
			}
		}
		return null
	}

	//! pre-allocate all to get rid of branching once we have some idea how many we can have.

	/**
	 * Resets a pooled projectile for immediate reuse using direct component writes.
	 * This is more consistent and keeps masks and component data in sync.
	 */
	reuseProjectile(entityId, fireData) {
		const location = this.getEntityLocation(entityId)
		const { chunkId, indexInChunk } = location

		// --- Direct Writes for Immediate State Reset ---
		this.clearBit(this.isPooledMaskId, chunkId, indexInChunk)
		this.setBit(this.isActiveMaskId, chunkId, indexInChunk)

		this.getComponentData(chunkId, lifecycleState).state[indexInChunk] = LIFECYCLE.ACTIVE
		this.getComponentData(chunkId, visibility).isVisible[indexInChunk] = 1
		this.getComponentData(chunkId, distanceTraveled).value[indexInChunk] = 0
		this.getComponentData(chunkId, hitHistory).count[indexInChunk] = 0

		const owners = this.getComponentData(chunkId, owner)
		owners.entityId[indexInChunk] = fireData.playerId

		const positions = this.getComponentData(chunkId, position)
		positions.x[indexInChunk] = fireData.spawnX
		positions.y[indexInChunk] = fireData.spawnY

		const velocities = this.getComponentData(chunkId, velocity)
		velocities.x[indexInChunk] = fireData.normFireX * fireData.finalSpeed
		velocities.y[indexInChunk] = fireData.normFireY * fireData.finalSpeed

		this.getComponentData(chunkId, rotation).angle[indexInChunk] = fireData.angle
		this.getComponentData(chunkId, range).value[indexInChunk] = fireData.projectileRange
		this.getComponentData(chunkId, damage).value[indexInChunk] = fireData.projectileDamage

		this.markEntitiesDirtyById(entityId, [lifecycleState, visibility])
	}

	createNewProjectile(fireData) {
		this.projectileMutators.owner.entityId[0] = fireData.playerId
		this.projectileMutators.position.x[0] = fireData.spawnX
		this.projectileMutators.position.y[0] = fireData.spawnY
		this.projectileMutators.velocity.x[0] = fireData.normFireX * fireData.finalSpeed
		this.projectileMutators.velocity.y[0] = fireData.normFireY * fireData.finalSpeed
		this.projectileMutators.rotation.angle[0] = fireData.angle
		this.projectileMutators.range.value[0] = fireData.projectileRange
		this.projectileMutators.damage.value[0] = fireData.projectileDamage

		this.instantiate(this.projectilePayload, 1)
	}
}
