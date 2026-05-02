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
	aiParameters,
	visibility,
} = ecs.getComponentIDs()

const { SpatialHashGrid } = await import(`@core/DataStructures/SpatialHashGrid.js`)

// A fixed radius around the player considered the "safe zone". Enemies will spawn outside this radius.
const SAFE_SPAWN_RADIUS = 2200

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
		this.maxSpawnsPerFrame = 100 //  maximum number of entities to spawn in a single frame.
		this.entitiesToUnpool = []
		this.waveChoiceResult = { chosenEnemies: [], spentBudget: 0 }
		this.affordableEnemiesCache = []

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

		// Add an index to each enemy info object for easy lookup from the spawn queue.
		this.spawnableEnemies.forEach((enemy, index) => (enemy.index = index))

		// --- Generic Pooling Setup ---
		// A single query to find all pooled entities that have a prefab ID.
		this.pooledEnemyQuery = this.getQuery({
			with: [isPooled, prefab, health],
		})

		// A reusable map to avoid allocations in the spawn loop.
		// The map and its arrays are created once and cleared each frame.
		this.availablePooledEnemies = new Map()

		// Pre-compile payloads and cache prefab IDs for all spawnable enemies.
		for (const enemy of this.spawnableEnemies) {
			// Get  numeric prefab ID
			enemy.prefabId = prefabManager.getPrefabId(enemy.prefabName)
			if (enemy.prefabId !== undefined) {
				// This is now a true SoA to avoid object allocations when gathering.
				const POOLED_ENEMY_CAPACITY = 1024 // A reasonable capacity for pooled enemies of one type.
				this.availablePooledEnemies.set(enemy.prefabId, {
					entityIds: new BigUint64Array(POOLED_ENEMY_CAPACITY),
					maxHealths: new Float32Array(POOLED_ENEMY_CAPACITY),
					count: 0,
				})
				// Pre-compile a max-capacity payload for new creations. This is the core
				// of the new optimization. We compile once at init and reuse the payload
				// buffer at runtime.
				enemy.creationPayload = this.compile(enemy.prefabName, {
					count: this.maxSpawnsPerFrame, // Compile with max capacity
					overrides: {
						position: {},
						threatCost: {},
						aiParameters: {},
					},
				})
			}
		}
		// Filter out any enemies that failed to compile.
		this.spawnableEnemies = this.spawnableEnemies.filter(e => e.prefabId !== undefined && e.creationPayload)

		// Pre-calculate the minimum cost of any spawnable enemy.
		this.minSpawnCost =
			this.spawnableEnemies.length > 0
				? this.spawnableEnemies.reduce((min, e) => Math.min(min, e.cost), Infinity)
				: Infinity

		// Payload for resetting and reusing a pooled enemy.
		// This is compiled with a count of 1 and mutated in a loop for each reused entity.
		this.resetEnemyPayload = this.compile({
			lifecycleState: { flags: LIFECYCLE.ACTIVE },
			velocity: { x: 0, y: 0 },
			tint: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
			hitFlash: { timer: 0.0 },
			visibility: { isVisible: 1 }, // Make it visible again
			// These components have dynamic data that will be set by mutators.
			aiParameters: {},
			position: {},
			health: {},
			threatCost: {},
		})

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

		// A pre-allocated SoA structure to batch new creation requests by enemy type index.
		this.newCreationsBatch = {
			batches: Array.from({ length: this.spawnableEnemies.length }, () => ({
				x: new Float64Array(this.maxSpawnsPerFrame),
				y: new Float64Array(this.maxSpawnsPerFrame),
				spawnIndex: new Uint32Array(this.maxSpawnsPerFrame),
				count: 0,
			})),
		}

		// --- Spawn Throttling & Batching ---
		// A pre-allocated SoA queue to hold spawn requests, avoiding per-request object allocation.
		const SPAWN_QUEUE_CAPACITY = 2048
		this.spawnQueue = {
			enemyInfoIndex: new Uint16Array(SPAWN_QUEUE_CAPACITY),
			x: new Float64Array(SPAWN_QUEUE_CAPACITY),
			y: new Float64Array(SPAWN_QUEUE_CAPACITY),
			count: 0,
			capacity: SPAWN_QUEUE_CAPACITY,
		}
		this.spawnIndexCounter = 0 // A counter for positioning entities within a cluster.
		// A reusable object for finding spawn locations to avoid allocations.
		this.spawnLocation = { x: 0, y: 0 }
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
			if (directorState.threatBudget[0] >= this.minSpawnCost && directorState.threatBudget[0] >= minSpawnBudget) {
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
		this._chooseEnemiesForWave(budget, this.waveChoiceResult)
		const { chosenEnemies, spentBudget } = this.waveChoiceResult
		if (chosenEnemies.length === 0) {
			return 0 // Nothing was spawned, so no budget was spent.
		}

		const foundLocation = this._findEmptySpawnLocation(this.spawnLocation)
		if (!foundLocation) {
			//console.warn('DirectorSystem: Could not find an empty spot to spawn wave. Skipping wave, budget not spent.')
			return 0 // Could not spawn, so no budget was spent.
		}

		// If the queue was empty, we are starting a new cluster, so reset the index.
		if (this.spawnQueue.count === 0) {
			this.spawnIndexCounter = 0
		}

		// Enqueue the spawn requests into our SoA queue to be throttled.
		const queue = this.spawnQueue
		for (const enemyInfo of chosenEnemies) {
			if (queue.count >= queue.capacity) break // Queue is full
			queue.enemyInfoIndex[queue.count] = enemyInfo.index
			queue.x[queue.count] = this.spawnLocation.x
			queue.y[queue.count] = this.spawnLocation.y
			queue.count++
		}

		return spentBudget
	}

	/**
	 * Finds a suitable empty location off-screen to spawn an enemy cluster.
	 * It uses a "guess and check" approach with the spatial hash grid.
	 * @param {object} outLocation - An object to write the found coordinates to.
	 * @returns {boolean} True if a location was found, false otherwise.
	 * @private
	 */
	_findEmptySpawnLocation(outLocation) {
		let playerX = 0
		let playerY = 0
		// singleton query
		const playerChunkIds = this.playerQuery.getChunks()

		const playerChunkId = playerChunkIds[0]

		const playerPositions = this.getComponentData(playerChunkId, position)
		playerX = playerPositions.x[0]
		playerY = playerPositions.y[0]

		const MAX_SPAWN_ATTEMPTS = 10
		const WAVE_CLUSTER_RADIUS = 200 // The radius of the area we need to be empty.
		// The distance from the player to search for a spawn point, ensuring it's outside the safe zone.
		const searchRadius = SAFE_SPAWN_RADIUS + WAVE_CLUSTER_RADIUS

		for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
			const randomAngle = Math.random() * 2 * Math.PI
			const x = playerX + searchRadius * Math.cos(randomAngle)
			const y = playerY + searchRadius * Math.sin(randomAngle)

			// The queryRadius method resets the count internally.
			this.grid.queryRadius(x, y, WAVE_CLUSTER_RADIUS, this.spawnQueryResult)

			if (this.spawnQueryResult.count === 0) {
				outLocation.x = x
				outLocation.y = y
				return true // Found an empty spot.
			}
		}

		return false // Failed to find a spot.
	}

	_gatherPooledEnemies() {
		// Clear the arrays inside the map, but don't re-allocate the map or the arrays themselves.
		// Iterate over the known spawnable enemies to avoid allocating a map iterator.
		for (const enemyInfo of this.spawnableEnemies) {
			const pool = this.availablePooledEnemies.get(enemyInfo.prefabId)
			// The pool is guaranteed to exist because we created it in init().
			pool.count = 0
		}

		const pooledChunkIds = this.pooledEnemyQuery.getChunks()
		for (let i = 0; i < pooledChunkIds.length; i++) {
			const chunkId = pooledChunkIds[i]
			const prefabs = this.getComponentData(chunkId, prefab)
			const healths = this.getComponentData(chunkId, health)
			const entities = this.getEntities(chunkId)
			const chunkSize = this.getChunkSize(chunkId)

			for (let j = 0; j < chunkSize; j++) {
				const prefabId = prefabs.id[j]
				const poolForType = this.availablePooledEnemies.get(prefabId)
				if (poolForType && poolForType.count < poolForType.capacity) {
					const index = poolForType.count
					poolForType.entityIds[index] = entities[j]
					poolForType.maxHealths[index] = healths.max[j]
					poolForType.count++
				}
			}
		}
	}

	_processSpawnQueue(currentTick) {
		const processCount = Math.min(this.spawnQueue.count, this.maxSpawnsPerFrame)
		if (processCount === 0) {
			return
		}

		// --- Batch Processing Setup ---
		this._gatherPooledEnemies()
		const separation = 48
		const phi = (1 + Math.sqrt(5)) / 2

		// Clear per-frame buffers.
		for (const batch of this.newCreationsBatch.batches) {
			batch.count = 0
		}
		this.entitiesToUnpool.length = 0

		// 1. Group spawn requests into reuses and new creations.
		for (let i = 0; i < processCount; i++) {
			// Process from the end of the queue and decrement count to "pop" them.
			const reqIndex = --this.spawnQueue.count
			const enemyInfo = this.spawnableEnemies[this.spawnQueue.enemyInfoIndex[reqIndex]]
			const locationX = this.spawnQueue.x[reqIndex]
			const locationY = this.spawnQueue.y[reqIndex]
			const index = this.spawnIndexCounter++

			// Look up available entities using the numeric prefabId, not the string name.
			const pooledForType = this.availablePooledEnemies.get(enemyInfo.prefabId)
			if (pooledForType && pooledForType.count > 0) {
				pooledForType.count--
				const reuseIndex = pooledForType.count
				const entityToReuseId = pooledForType.entityIds[reuseIndex]
				const maxHealthToReuse = pooledForType.maxHealths[reuseIndex]

				this.entitiesToUnpool.push(entityToReuseId)
				this._resetReusedEnemy(
					entityToReuseId,
					enemyInfo,
					locationX,
					locationY,
					index,
					separation,
					phi,
					maxHealthToReuse,
				)
			} else {
				const batch = this.newCreationsBatch.batches[enemyInfo.index]
				const newIndex = batch.count
				batch.x[newIndex] = locationX
				batch.y[newIndex] = locationY
				batch.spawnIndex[newIndex] = index
				batch.count++
			}
		}

		// 2. Process reuses.
		if (this.entitiesToUnpool.length > 0) {
			// Issue one bulk command to remove the 'isPooled' tag from all reused entities.
			this.removeComponentsFromEntities(this.entitiesToUnpool, isPooled)
		}

		// 3. Process new creations in batches.
		for (let i = 0; i < this.newCreationsBatch.batches.length; i++) {
			const batch = this.newCreationsBatch.batches[i]
			if (batch.count > 0) {
				const enemyInfo = this.spawnableEnemies[i]
				this._createNewEnemiesInBatch(enemyInfo, batch, separation, phi)
			}
		}
	}

	/**
	 * Creates a batch of new enemies of the same type using a single `instantiate` command.
	 * This method no longer compiles; it reuses a pre-compiled payload.
	 * @private
	 */
	_createNewEnemiesInBatch(enemyInfo, requests, separation, phi) {
		const count = requests.count
		if (count === 0) return

		// Get the pre-compiled payload.
		const payload = enemyInfo.creationPayload

		// Fill the payload's buffers with unique data for each entity.
		for (let i = 0; i < count; i++) {
			const locationX = requests.x[i]
			const locationY = requests.y[i]
			const index = requests.spawnIndex[i]
			const radius = Math.sqrt(index + 0.5) * separation
			const angle = 2 * Math.PI * index * phi

			payload.buffers.position.x[i] = locationX + radius * Math.cos(angle)
			payload.buffers.position.y[i] = locationY + radius * Math.sin(angle)
			payload.buffers.threatCost.value[i] = enemyInfo.cost
			payload.buffers.aiParameters.randomSeed[i] = Math.random()
		}

		// Issue a single, highly efficient command to create `count` entities.
		// The payload has a larger capacity, but we only use the first `count` slots.
		this.instantiate(payload, count)
	}

	/**
	 * Issues commands to reset a single pooled enemy's state.
	 * @private
	 */
	_resetReusedEnemy(entityId, enemyInfo, locationX, locationY, index, separation, phi, maxHealth) {
		// --- 1. Calculate new position ---
		const radius = Math.sqrt(index + 0.5) * separation
		const angle = 2 * Math.PI * index * phi
		const enemyX = locationX + radius * Math.cos(angle)
		const enemyY = locationY + radius * Math.sin(angle)

		// --- 2. set the dynamic data for the reused enemy ---
		const buffers = this.resetEnemyPayload.buffers
		buffers.position.x[0] = enemyX
		buffers.position.y[0] = enemyY
		buffers.health.current[0] = maxHealth
		buffers.health.max[0] = maxHealth
		buffers.threatCost.value[0] = enemyInfo.cost
		buffers.aiParameters.randomSeed[0] = Math.random()

		// --- 3. Issue a command to reset the entity's state ---
		// This single command updates all necessary components for the enemy's new life,
		// It sets lifecycle to ACTIVE, resets velocity and tint to defaults, and applies
		// the new position, health, and threat cost from buffers.

		this.setComponents(entityId, this.resetEnemyPayload)
	}

	/**
	 * Selects a list of enemies to spawn based on the available budget and weights.
	 * This version is more robust, ensuring it spends the budget effectively by only
	 * considering affordable enemies at each step.
	 * @param {number} initialBudget - The total budget to spend.
	 * @param {object} outResult - An object to write the results to, to avoid allocations.
	 * @param {object[]} outResult.chosenEnemies - The output array for chosen enemies.
	 * @param {number} outResult.spentBudget - The output for the budget spent.
	 * @private
	 */
	_chooseEnemiesForWave(initialBudget, outResult) {
		outResult.chosenEnemies.length = 0
		const chosenEnemies = outResult.chosenEnemies
		let remainingBudget = initialBudget

		const minCost = this.minSpawnCost

		// Ensure we can afford at least the cheapest enemy.
		while (remainingBudget >= minCost) {
			// 1. Get a list of affordable enemies and their total weight without allocating new arrays.
			this.affordableEnemiesCache.length = 0
			let totalWeight = 0
			for (const enemy of this.spawnableEnemies) {
				if (enemy.cost <= remainingBudget) {
					this.affordableEnemiesCache.push(enemy)
					totalWeight += enemy.weight
				}
			}

			if (this.affordableEnemiesCache.length === 0) break

			// 3. Pick one enemy from the affordable list using weighted random selection.
			const randomWeight = Math.random() * totalWeight
			let weightSum = 0,
				chosenEnemy = null
			for (const enemy of this.affordableEnemiesCache) {
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

		outResult.spentBudget = initialBudget - remainingBudget
	}
}
