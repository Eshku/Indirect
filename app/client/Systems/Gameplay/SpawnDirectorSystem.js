const { engine } = await import(`@client/Engine.js`)
const { ecs, entityManager, gameManager, physicsManager, prefabManager } = engine.getManagers()

const { SpriteFactorySystem, RenderLayerSystem } = ecs.getSystemIDs()

const {
	spawnDirector,
	playerTag,
	position,
	lifecycleState,
	health,
	velocity,
	threatCost,
	tint,
	aiParameters,
	visibility,
	scale,
	spinningDroneTag,
	explosiveDroneTag,
} = ecs.getComponentIDs()

const { SpatialHashGrid } = await import(`@core/DataStructures/SpatialHashGrid.js`)

// A fixed radius around the player considered the "safe zone". Enemies will spawn outside this radius.
const SAFE_SPAWN_RADIUS = 2000

const SPAWN_ANIMATION_DURATION = 1
const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')

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
			{ prefabName: 'spinningDrone', cost: 5, weight: 10, tagId: spinningDroneTag },
			{ prefabName: 'explosiveDrone', cost: 15, weight: 2, tagId: explosiveDroneTag },
		]

		// Add an index to each enemy info object for easy lookup from the spawn queue.
		this.spawnableEnemies.forEach((enemy, index) => (enemy.index = index))

		// Pre-compile payloads and cache prefab IDs for all spawnable enemies.
		for (const enemy of this.spawnableEnemies) {
			// --- Type-Specific Pooling Setup ---
			// Create a dedicated query and pool for each enemy type.
			enemy.pooledQuery = this.getQuery({
				with: [enemy.tagId, lifecycleState],
			})
			enemy.pool = [] // A simple array to hold pooled entity IDs.

			// Pre-compile a max-capacity payload for creating NEW enemies of this type.
			// This is the core of the new optimization. We compile once at init and
			// reuse the payload buffer at runtime.
			if (enemy.tagId) {
				enemy.creationPayload = this.compile(enemy.prefabName, {
					count: this.maxSpawnsPerFrame, // Compile with max capacity
					overrides: {
						position: {},
						threatCost: {},
						aiParameters: {},
						lifecycleState: {
							state: LIFECYCLE.SPAWNING,
							timer: SPAWN_ANIMATION_DURATION,
							duration: SPAWN_ANIMATION_DURATION,
						},
						visibility: { isVisible: 1 },
						// Set the initial scale to match the start of the spawn animation.
						scale: { x: 0.01, y: 0.01 },
					},
				})
			}
		}

		// Pre-calculate the minimum cost of any spawnable enemy.
		this.minSpawnCost =
			this.spawnableEnemies.length > 0
				? this.spawnableEnemies.reduce((min, e) => Math.min(min, e.cost), Infinity)
				: Infinity

		// Get mask IDs for lifecycle states
		this.isSpawningMaskId = this.getMaskId('isSpawning')
		this.isPooledMaskId = this.getMaskId('isPooled')

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

		// A set to track which chunks have had their components modified this frame for reuse.
		this.modifiedChunksForReactiveSystems = new Set()
	}

	update({ deltaTime }) {
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
				const spentBudget = this.spawnWave(directorState.threatBudget[0])

				// Deduct the budget that was actually spent.
				directorState.threatBudget[0] -= spentBudget
			}
		}

		// Process a batch of spawn requests from the queue each frame.
		this._processSpawnQueue()
	}

	/**
	 * Orchestrates the spawning of a wave of enemies. It chooses which enemies to spawn,
	 * finds a suitable location, and then creates the enemy entities.
	 * @param {number} budget The threat budget available for this wave.
	 * @returns {number} The amount of budget that was actually spent.
	 */
	spawnWave(budget) {
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

	/**
	 * Gathers all available pooled entities for each spawnable enemy type.
	 * This is the "gather" step that populates the pools for reuse.
	 * @private
	 */
	_gatherPooledEnemiesByType() {
		for (const enemyInfo of this.spawnableEnemies) {
			enemyInfo.pool.length = 0 // Clear the pool from the previous frame.
			const pooledChunkIds = enemyInfo.pooledQuery.getChunks()
			for (const chunkId of pooledChunkIds) {
				const entities = this.getEntities(chunkId)
				// Use the mask to efficiently find all pooled entities of this type.
				const pooledCount = this.getIndicesFromMask(this.isPooledMaskId, chunkId, this.spawnQueryResult.entityIndices) // Re-use a scratch buffer
				for (let j = 0; j < pooledCount; j++) {
					const indexInChunk = this.spawnQueryResult.entityIndices[j]
					enemyInfo.pool.push(entities[indexInChunk])
				}
			}
		}
	}

	_processSpawnQueue() {
		this.modifiedChunksForReactiveSystems.clear()
		const processCount = Math.min(this.spawnQueue.count, this.maxSpawnsPerFrame)
		if (processCount === 0) {
			return
		}

		// --- Batch Processing Setup ---
		this._gatherPooledEnemiesByType()
		const separation = 48
		const phi = (1 + Math.sqrt(5)) / 2

		// Clear per-frame buffers.
		for (const batch of this.newCreationsBatch.batches) {
			batch.count = 0
		}

		// 1. Group spawn requests into reuses and new creations.
		for (let i = 0; i < processCount; i++) {
			// Process from the end of the queue and decrement count to "pop" them.
			const reqIndex = --this.spawnQueue.count
			const enemyInfo = this.spawnableEnemies[this.spawnQueue.enemyInfoIndex[reqIndex]]
			const locationX = this.spawnQueue.x[reqIndex]
			const locationY = this.spawnQueue.y[reqIndex]
			const index = this.spawnIndexCounter++

			// Prioritize reusing an entity from the specific pool for this enemy type.
			if (enemyInfo.pool.length > 0) {
				const entityToReuseId = enemyInfo.pool.pop()
				this._resetReusedEnemy(
					entityToReuseId,
					enemyInfo,
					locationX,
					locationY,
					index,
					separation,
					phi,
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

		// 3. Process new creations in batches.
		for (let i = 0; i < this.newCreationsBatch.batches.length; i++) {
			const batch = this.newCreationsBatch.batches[i]
			if (batch.count > 0) {
				const enemyInfo = this.spawnableEnemies[i]
				this._createNewEnemiesInBatch(enemyInfo, batch, separation, phi)			
			}
		}

		// After processing, mark the chunks containing reused entities as dirty for reactive systems.
		for (const chunkId of this.modifiedChunksForReactiveSystems) {
			this.markComponentDirty(chunkId, lifecycleState)
			this.markComponentDirty(chunkId, health)
			this.markComponentDirty(chunkId, tint)
			this.markComponentDirty(chunkId, scale)
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
	_resetReusedEnemy(entityId, enemyInfo, locationX, locationY, index, separation, phi) {		
		// --- 1. Calculate new spawn position ---
		const radius = Math.sqrt(index + 0.5) * separation
		const angle = 2 * Math.PI * index * phi
		const enemyX = locationX + radius * Math.cos(angle)
		const enemyY = locationY + radius * Math.sin(angle)

		// --- 2. Get component data via direct access ---
		const location = this.getEntityLocation(entityId)

		const { chunkId, indexInChunk } = location

		const states = this.getComponentData(chunkId, lifecycleState)
		const positions = this.getComponentData(chunkId, position)
		const healths = this.getComponentData(chunkId, health)
		const costs = this.getComponentData(chunkId, threatCost)
		const aiParams = this.getComponentData(chunkId, aiParameters)
		const visibilities = this.getComponentData(chunkId, visibility)
		const velocities = this.getComponentData(chunkId, velocity)
		const tints = this.getComponentData(chunkId, tint)
		const scales = this.getComponentData(chunkId, scale)

		// --- 3. Perform direct writes to reset the entity's state immediately ---
		// Manually flip the state bits for this reused entity.
		this.clearBit(this.isPooledMaskId, chunkId, indexInChunk)
		this.setBit(this.isSpawningMaskId, chunkId, indexInChunk)

		states.state[indexInChunk] = LIFECYCLE.SPAWNING
		states.timer[indexInChunk] = SPAWN_ANIMATION_DURATION
		states.duration[indexInChunk] = SPAWN_ANIMATION_DURATION

		positions.x[indexInChunk] = enemyX
		positions.y[indexInChunk] = enemyY

		const maxHealth = healths.max[indexInChunk] // Get max health from the entity itself
		healths.current[indexInChunk] = maxHealth

		costs.value[indexInChunk] = enemyInfo.cost
		aiParams.randomSeed[indexInChunk] = Math.random()

		visibilities.isVisible[indexInChunk] = 1

		velocities.x[indexInChunk] = 0
		velocities.y[indexInChunk] = 0

		tints.r[indexInChunk] = 1.0; tints.g[indexInChunk] = 1.0; tints.b[indexInChunk] = 1.0; tints.a[indexInChunk] = 1.0

		scales.x[indexInChunk] = 0.01; scales.y[indexInChunk] = 0.01

		// --- 4. Mark all trackable components as dirty for same-frame reactivity ---
		// Narrow-phase marking for specific entities.
		this.markEntitiesDirtyById(entityId, [lifecycleState, health, visibility, tint, scale])
		// Broad-phase marking for the chunk, so reactive systems pick it up.
		this.modifiedChunksForReactiveSystems.add(chunkId)
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
