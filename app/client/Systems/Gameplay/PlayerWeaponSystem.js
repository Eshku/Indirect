const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')
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
	isPooled,
	range,
	damage,
	hitHistory,
} = ecs.getComponentIDs()

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
		const { payload, mutators } = this.compile('slashingArc')
		this.projectilePayload = payload
		this.projectileMutators = mutators

		// Pre-compile a single payload to reset all necessary components on a reused projectile.
		// This is much more efficient than sending multiple `setComponentData` commands.
		const { payload: reusePayload, mutators: reuseMutators } = this.compile({
			owner: {},
			position: {},
			velocity: {},
			rotation: {},
			range: {},
			damage: {},
			distanceTraveled: { value: 0 },
			hitHistory: { count: 0 },
			lifecycleState: { flags: LIFECYCLE.ACTIVE },
		})
		this.reuseProjectilePayload = reusePayload
		this.reuseProjectileMutators = reuseMutators
	}

	update({ currentTick }) {
		let intentValue, cooldownTimer, playerX, playerY, playerStats, cursorX, cursorY

		const playerChunk = this.playerQuery.getSingleChunk()

		intentValue = playerChunk.componentData[shootingIntent].shootingIntent[0]
		cooldownTimer = playerChunk.componentData[weaponCooldown].timer[0]
		playerX = playerChunk.componentData[position].x[0]
		playerY = playerChunk.componentData[position].y[0]
		playerStats = playerChunk.componentData[playerWeaponStats] // Keep SoA object for multiple property access

		// Check for intent and if cooldown is ready.
		if (intentValue !== 1 || cooldownTimer > 0) {
			return
		}

		const cursorChunk = this.cursorQuery.getSingleChunk()
		if (cursorChunk) {
			cursorX = cursorChunk.componentData[position].x[0]
			cursorY = cursorChunk.componentData[position].y[0]
		}

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
			this.reuseProjectile(availablePooledProjectile, fireData, currentTick)
		} else {
			this.createNewProjectile(fireData, currentTick)
		}

		// Reset cooldown using direct writes for better performance and immediate effect.
		const cooldowns = playerChunk.componentData[weaponCooldown]
		cooldowns.timer[0] = playerStats.fireRate[0]
		// Enable the component so the CooldownSystem will process it.
		playerChunk.enableComponent(0, weaponCooldown)
	}

	findAvailableProjectile() {
		// `iter()` is a generator, so this will stop after the first non-empty chunk.
		for (const chunk of this.pooledProjectileQuery.iter()) {
			if (chunk.size > 0) {
				// Return the chunk and the index of the first available entity.
				return { chunk, index: 0, entityId: chunk.entities[0] }
			}
		}
		return null
	}

	//! pre-allocate all to get rid of branching once we have some idea how many we can have.

	reuseProjectile(pooledInfo, fireData, currentTick) {
		const { entityId } = pooledInfo

		// Use the pre-compiled mutators to modify the pre-compiled payload's buffer
		this.reuseProjectileMutators.owner.entityId[0] = fireData.playerId
		this.reuseProjectileMutators.position.x[0] = fireData.spawnX
		this.reuseProjectileMutators.position.y[0] = fireData.spawnY
		this.reuseProjectileMutators.velocity.x[0] = fireData.normFireX * fireData.finalSpeed
		this.reuseProjectileMutators.velocity.y[0] = fireData.normFireY * fireData.finalSpeed
		this.reuseProjectileMutators.rotation.angle[0] = fireData.angle
		this.reuseProjectileMutators.range.value[0] = fireData.projectileRange
		this.reuseProjectileMutators.damage.value[0] = fireData.projectileDamage

		// Issue deferred commands to make the state change atomic from the perspective of other systems.
		// 1. This is the structural change that moves the entity to an "active" archetype.
		this.removeComponent(entityId, isPooled)
		// 2. This single command updates all necessary components for the projectile's new life.
		// All data changes will be applied *after* the structural change is complete.
		this.setComponentsData(entityId, this.reuseProjectilePayload)
	}

	createNewProjectile(fireData, currentTick) {
		this.projectileMutators.owner.entityId[0] = fireData.playerId
		this.projectileMutators.position.x[0] = fireData.spawnX
		this.projectileMutators.position.y[0] = fireData.spawnY
		this.projectileMutators.velocity.x[0] = fireData.normFireX * fireData.finalSpeed
		this.projectileMutators.velocity.y[0] = fireData.normFireY * fireData.finalSpeed
		this.projectileMutators.rotation.angle[0] = fireData.angle
		this.projectileMutators.range.value[0] = fireData.projectileRange
		this.projectileMutators.damage.value[0] = fireData.projectileDamage

		this.createEntity(this.projectilePayload)
	}
}
