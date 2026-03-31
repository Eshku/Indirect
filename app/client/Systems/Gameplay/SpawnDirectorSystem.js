const { engine } = await import(`@client/Engine.js`)
const { ecs, entityManager, gameManager, physicsManager, prefabManager } = engine.getManagers()

const {
	spawnDirector,
	playerTag,
	position,
	prefab,
	isPooled,
	lifecycleState,
	health,
	velocity,
	threatCost,
	tint,
	hitFlash,
} = ecs.getComponentIDs()

const { SpatialHashGrid } = await import(`@core/DataStructures/SpatialHashGrid.js`)

const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')

/**
 * The DirectorSystem is responsible for procedurally spawning enemies.
 * It runs on a timer and, when triggered, spawns a cluster of enemies
 * at a location outside the player's current view.
 */
export class SpawnDirectorSystem {
	static dependencies = {
		// Declare that this system writes to the SpawnDirector component.
		update: {
			writes: [spawnDirector],
		},
	}

	init() {
		// A singleton query to find the director's state.
		this.directorQuery = this.getQuery({
			with: [spawnDirector],
		})

		// A query to find the player, used for positioning spawns.
		this.playerQuery = this.getQuery({
			with: [playerTag, position],
		})

		this.playerId = this.playerQuery.getSingleEntity()

		if (!this.playerId) {
			console.error('DirectorSystem: Could not find player entity during initialization.')
		}

		// The SpawnDirector entity is now created from a prefab in client.js
		// to ensure it exists on the first frame.
		// --- Define and pre-compile all spawnable enemies ---
		this.spawnableEnemies = [
			{ prefabName: 'spinningDrone', cost: 5, weight: 10 },
			{ prefabName: 'explosiveDrone', cost: 15, weight: 2 },
		]

		// --- Generic Pooling Setup ---
		// A single query to find all pooled entities that have a prefab ID.
		this.pooledEnemyQuery = this.getQuery({
			with: [isPooled, prefab, health],
		})

		// Pre-compile payloads and cache prefab IDs for all spawnable enemies.
		for (const enemy of this.spawnableEnemies) {
			try {
				const { payload, mutators } = this.compile(enemy.prefabName)
				enemy.payload = payload
				enemy.mutators = mutators

				// Get the numeric prefab ID from the manager. This is the "fast path" for systems.
				enemy.prefabId = prefabManager.getPrefabId(enemy.prefabName)
				if (enemy.prefabId === undefined) {
					throw new Error(`Could not find prefab ID for "${enemy.prefabName}". Is it in the manifest and preloaded?`)
				}
			} catch (e) {
				console.error(`DirectorSystem: Failed to compile prefab "${enemy.prefabName}". It will not be spawned.`, e)
			}
		}
		// Filter out any enemies that failed to compile.
		this.spawnableEnemies = this.spawnableEnemies.filter(e => e.payload)

		// Pre-compile a single payload to reset all necessary components on a reused enemy.
		// This is much more efficient than sending multiple `setComponentData` commands.
		const { payload: reuseEnemyPayload, mutators: reuseEnemyMutators } = this.compile({
			lifecycleState: { flags: LIFECYCLE.ACTIVE },
			velocity: { x: 0, y: 0 },
			tint: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
			hitFlash: { timer: 0.0 },
			// These components have dynamic data that will be set by mutators.
			position: {},
			health: {},
			threatCost: {},
		})
		this.reuseEnemyPayload = reuseEnemyPayload
		this.reuseEnemyMutators = reuseEnemyMutators

		// Get access to the spatial hash grid for finding empty spawn locations.
		const gridSABs = physicsManager.getSpatialHashGridSABs()
		this.grid = new SpatialHashGrid(gridSABs)
		// A reusable query result object to avoid allocations in the update loop.
		const MAX_SPAWN_QUERY_RESULTS = 256 // Should be enough for checking a spawn area
		this.spawnQueryResult = {
			count: 0,
			capacity: MAX_SPAWN_QUERY_RESULTS,
			entityIds: new BigUint64Array(MAX_SPAWN_QUERY_RESULTS),
			chunkIds: new Uint16Array(MAX_SPAWN_QUERY_RESULTS),
			entityIndices: new Uint16Array(MAX_SPAWN_QUERY_RESULTS),
		}

		// A reusable map to avoid allocations in the spawn loop.
		this.availablePooledEnemies = new Map()
	}

	update({ deltaTime, currentTick }) {
		// This system only acts if a SpawnDirector entity exists.
		for (const chunk of this.directorQuery.iter()) {
			const directorState = chunk.componentData[spawnDirector]

			const currentBudget = directorState.threatBudget[0]
			let growthRate = directorState.threatGrowthRate[0]
			const maxBudget = directorState.maxThreatBudget[0]
			const minSpawnBudget = directorState.minSpawnBudget[0]
			const escalationRate = directorState.threatGrowthEscalationRate[0]

			// Escalate the growth rate and accrue threat budget based on the elapsed time.
			growthRate += escalationRate * deltaTime
			directorState.threatGrowthRate[0] = growthRate
			directorState.threatBudget[0] = Math.min(maxBudget, currentBudget + growthRate * deltaTime)

			// Check if we have enough budget to trigger a spawn wave.
			if (directorState.threatBudget[0] >= minSpawnBudget) {
				// Spend the budget and spawn the wave.
				const spentBudget = this.spawnWave(directorState.threatBudget[0], currentTick)

				// Deduct the budget that was actually spent.
				directorState.threatBudget[0] -= spentBudget
			}
		}
	}

	/**
	 * Orchestrates the spawning of a wave of enemies. It chooses which enemies to spawn,
	 * finds a suitable location, and then creates the enemy entities.
	 * @param {number} budget The threat budget available for this wave.
	 * @returns {number} The amount of budget that was actually spent.
	 */
	spawnWave(budget, currentTick) {
		const { chosenEnemies, spentBudget } = this._chooseEnemiesForWave(budget)
		if (chosenEnemies.length === 0) {
			return 0 // Nothing was spawned, so no budget was spent.
		}

		const spawnLocation = this._findEmptySpawnLocation()
		if (!spawnLocation) {
			//console.warn('DirectorSystem: Could not find an empty spot to spawn wave. Skipping wave, budget not spent.')
			return 0 // Could not spawn, so no budget was spent.
		}

		this._spawnEnemyCluster(chosenEnemies, spawnLocation, currentTick)
		return spentBudget
	}

	/**
	 * Finds a suitable empty location off-screen to spawn an enemy cluster.
	 * It uses a "guess and check" approach with the spatial hash grid.
	 * @returns {{x: number, y: number} | null} The coordinates of the spawn location, or null if none was found.
	 * @private
	 */
	_findEmptySpawnLocation() {
		let playerX = 0
		let playerY = 0
		// This is a singleton query, so it will only run once.
		for (const chunk of this.playerQuery.iter()) {
			playerX = chunk.componentData[position].x[0]
			playerY = chunk.componentData[position].y[0]
		}
		const screen = gameManager.getApp().screen

		const MAX_SPAWN_ATTEMPTS = 10
		const WAVE_CLUSTER_RADIUS = 200 // The radius of the area we need to be empty.
		// The distance from the player to search for a spawn point, ensuring it's off-screen.
		const searchRadius = Math.sqrt(screen.width ** 2 + screen.height ** 2) / 2 + WAVE_CLUSTER_RADIUS

		for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
			const randomAngle = Math.random() * 2 * Math.PI
			const x = playerX + searchRadius * Math.cos(randomAngle)
			const y = playerY + searchRadius * Math.sin(randomAngle)

			// The queryRadius method resets the count internally.
			this.grid.queryRadius(x, y, WAVE_CLUSTER_RADIUS, this.spawnQueryResult)

			if (this.spawnQueryResult.count === 0) {
				return { x, y } // Found an empty spot.
			}
		}

		return null // Failed to find a spot.
	}

	/**
	 * Spawns a list of enemies in a spiral cluster pattern at a given location.
	 * @param {object[]} enemiesToSpawn - An array of enemy info objects to spawn.
	 * @param {{x: number, y: number}} location - The center of the spawn cluster.
	 * @private
	 */
	_spawnEnemyCluster(enemiesToSpawn, location, currentTick) {
		const separation = 48 // Base separation distance between enemies.
		const phi = (1 + Math.sqrt(5)) / 2 // Golden ratio for the spiral.

		if (enemiesToSpawn.length === 0) {
			return
		}

		// --- Generic Pooling: Gather all available enemies by prefabId in a single pass ---
		this.availablePooledEnemies.clear()

		for (const chunk of this.pooledEnemyQuery.iter()) {
			const prefabs = chunk.componentData[prefab]

			const healths = chunk.componentData[health]
			for (let i = 0; i < chunk.size; i++) {
				const prefabId = prefabs.id[i]
				if (!this.availablePooledEnemies.has(prefabId)) {
					this.availablePooledEnemies.set(prefabId, [])
				}
				this.availablePooledEnemies.get(prefabId).push({
						entityId: chunk.entities[i],
						maxHealth: healths.max[i],
				})
			}
		}

		for (let i = 0; i < enemiesToSpawn.length; i++) {
			const enemyInfo = enemiesToSpawn[i]
			let reused = false

			// Look up available entities using the numeric prefabId, not the string name.
			const pooledForType = this.availablePooledEnemies.get(enemyInfo.prefabId)
			if (pooledForType && pooledForType.length > 0) {
				const enemyToReuse = pooledForType.pop() // Take one from the pool
				this._reuseEnemy(
					enemyToReuse.entityId,
					enemyInfo,
					location,
					i,
					separation,
					phi,
					currentTick,
					enemyToReuse.maxHealth,
				)
				reused = true
			}

			if (!reused) {
				this._createNewEnemy(enemyInfo, location, i, separation, phi, currentTick)
			}
		}
	}

	_createNewEnemy(enemyInfo, location, index, separation, phi, currentTick) {
		// Use a Fibonacci spiral (sunflower) pattern for natural-looking distribution.
		const radius = Math.sqrt(index + 0.5) * separation
		const angle = 2 * Math.PI * index * phi

		const enemyX = location.x + radius * Math.cos(angle)
		const enemyY = location.y + radius * Math.sin(angle)

		enemyInfo.mutators.position.x[0] = enemyX
		enemyInfo.mutators.position.y[0] = enemyY
		// Stamp the threat cost onto the new enemy.
		enemyInfo.mutators.threatCost.value[0] = enemyInfo.cost
		// The command buffer automatically marks the SpriteDescriptor as dirty on creation,
		// so the SpriteFactorySystem will process this entity correctly.

		this.createEntity(enemyInfo.payload)
	}

	_reuseEnemy(entityId, enemyInfo, location, index, separation, phi, currentTick, maxHealth) {
		// --- 1. Calculate new position ---
		const radius = Math.sqrt(index + 0.5) * separation
		const angle = 2 * Math.PI * index * phi
		const enemyX = location.x + radius * Math.cos(angle)
		const enemyY = location.y + radius * Math.sin(angle)

		// --- 2. Use mutators to set the dynamic data for the reused enemy ---
		this.reuseEnemyMutators.position.x[0] = enemyX
		this.reuseEnemyMutators.position.y[0] = enemyY
		this.reuseEnemyMutators.health.current[0] = maxHealth
		this.reuseEnemyMutators.health.max[0] = maxHealth
		this.reuseEnemyMutators.threatCost.value[0] = enemyInfo.cost

		// --- 3. Issue commands to reactivate and reset the entity's state ---
		// This is a structural change that brings the entity back into the "active" world.
		this.removeComponent(entityId, isPooled) // Structural change: bring it back to the active world.
		// This single command updates all necessary components for the enemy's new life.
		// It sets lifecycle to ACTIVE, resets velocity and tint to defaults, and applies
		// the new position, health, and threat cost from the mutators.
		this.setComponentsData(entityId, this.reuseEnemyPayload)
	}

	/**
	 * Selects a list of enemies to spawn based on the available budget and weights.
	 * This version is more robust, ensuring it spends the budget effectively by only
	 * considering affordable enemies at each step.
	 * @param {number} initialBudget The total budget to spend.
	 * @returns {{chosenEnemies: object[], spentBudget: number}} An object containing the list of enemies and the total budget spent.
	 * @private
	 */
	_chooseEnemiesForWave(initialBudget) {
		const chosenEnemies = []
		let remainingBudget = initialBudget

		// Find the cost of the cheapest possible enemy to ensure the loop can start.
		const minCost = this.spawnableEnemies.length > 0 ? Math.min(...this.spawnableEnemies.map(e => e.cost)) : Infinity

		while (remainingBudget >= minCost) {
			// 1. Get a list of enemies we can currently afford.
			const affordableEnemies = this.spawnableEnemies.filter(e => e.cost <= remainingBudget)
			if (affordableEnemies.length === 0) break

			// 2. Calculate total weight of *only* the affordable enemies.
			const totalWeight = affordableEnemies.reduce((sum, e) => sum + e.weight, 0)

			// 3. Pick one enemy from the affordable list using weighted random selection.
			const randomWeight = Math.random() * totalWeight
			let weightSum = 0,
				chosenEnemy = null
			for (const enemy of affordableEnemies) {
				weightSum += enemy.weight
				if (randomWeight <= weightSum) {
					chosenEnemy = enemy
					break
				}
			}

			if (chosenEnemy) {
				chosenEnemies.push(chosenEnemy)
				remainingBudget -= chosenEnemy.cost
			} else {
				// This case should not be reached if affordableEnemies is not empty, but acts as a safeguard.
				break
			}
		}

		return { chosenEnemies, spentBudget: initialBudget - remainingBudget }
	}
}
