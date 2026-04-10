const { engine } = await import(`@client/Engine.js`)
const { ecs, entityManager, gameManager, physicsManager, prefabManager } = engine.getManagers()

const { SpriteFactorySystem, RenderLayerSystem } = ecs.getSystemIDs()

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

		// --- Spawn Throttling ---
		// A queue to hold spawn requests, allowing us to throttle entity creation.
		this.spawnQueue = []
		this.maxSpawnsPerFrame = 100 // The maximum number of entities to spawn in a single frame.
		this.spawnIndexCounter = 0 // A counter for positioning entities within a cluster.
	}

	update({ deltaTime, currentTick }) {
		// This system only acts if a SpawnDirector entity exists.
		const directorChunkIds = this.directorQuery.getChunks()
		for (let i = 0; i < directorChunkIds.length; i++) {
			const chunkId = directorChunkIds[i]
			const directorState = this.getComponentData(chunkId, spawnDirector)

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

		// Process a batch of spawn requests from the queue each frame.
		this._processSpawnQueue(currentTick)
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

		// If the queue was empty, we are starting a new cluster, so reset the index.
		if (this.spawnQueue.length === 0) {
			this.spawnIndexCounter = 0
		}

		// Enqueue the spawn requests instead of spawning them directly.
		for (const enemyInfo of chosenEnemies) {
			this.spawnQueue.push({ enemyInfo, location: spawnLocation })
		}

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
		const playerChunkIds = this.playerQuery.getChunks()

		const playerChunkId = playerChunkIds[0]

		const playerPositions = this.getComponentData(playerChunkId, position)
		playerX = playerPositions.x[0]
		playerY = playerPositions.y[0]

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

	_gatherPooledEnemies() {
		this.availablePooledEnemies.clear()

		const pooledChunkIds = this.pooledEnemyQuery.getChunks()
		for (let i = 0; i < pooledChunkIds.length; i++) {
			const chunkId = pooledChunkIds[i]
			const prefabs = this.getComponentData(chunkId, prefab)
			const healths = this.getComponentData(chunkId, health)
			const entities = this.getEntities(chunkId)
			const chunkSize = this.getChunkSize(chunkId)

			for (let j = 0; j < chunkSize; j++) {
				const prefabId = prefabs.id[j]
				if (!this.availablePooledEnemies.has(prefabId)) {
					this.availablePooledEnemies.set(prefabId, [])
				}
				this.availablePooledEnemies.get(prefabId).push({ entityId: entities[j], maxHealth: healths.max[j] })
			}
		}
	}

	_processSpawnQueue(currentTick) {
		const processCount = Math.min(this.spawnQueue.length, this.maxSpawnsPerFrame)
		if (processCount === 0) {
			return
		}

		this._gatherPooledEnemies()

		//! base separation on entity size? Prolly not worth it, just move up in
		//! config, so can be hardcoded manually.
		const separation = 48 // Base separation distance between enemies.
		const phi = (1 + Math.sqrt(5)) / 2 // Golden ratio for the spiral.

		for (let i = 0; i < processCount; i++) {
			const request = this.spawnQueue.shift()
			const { enemyInfo, location } = request
			const index = this.spawnIndexCounter++
			let reused = false

			// Look up available entities using the numeric prefabId, not the string name.
			const pooledForType = this.availablePooledEnemies.get(enemyInfo.prefabId)
			if (pooledForType && pooledForType.length > 0) {
				const enemyToReuse = pooledForType.pop() // Take one from the pool
				this._reuseEnemy(
					enemyToReuse.entityId,
					enemyInfo,
					location,
					index,
					separation,
					phi,
					currentTick,
					enemyToReuse.maxHealth,
				)
				reused = true
			}

			if (!reused) {
				this._createNewEnemy(enemyInfo, location, index, separation, phi, currentTick)
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
		this.setComponents(entityId, this.reuseEnemyPayload)
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
