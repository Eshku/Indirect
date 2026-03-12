const { engine } = await import(`@client/Engine.js`)
const { ecs, entityManager, gameManager, physicsManager } = engine.getManagers()

const { spawnDirector, playerTag, position, prefab } = ecs.getTypeIDs()
const { entityStore } = await import(`@managers/EntityManager/EntityManager.js`)
const { SpatialHashGrid } = await import(`@core/DataStructures/SpatialHashGrid.js`)

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

		// Create the singleton SpawnDirector entity. This command is deferred and will be
		// executed after all systems are initialized, ensuring it exists before the first update.
		const { payload } = this.compile({
			spawnDirector: {
				threatBudget: 10.0,
				threatGrowthRate: 5.0,
				maxThreatBudget: 1000.0,
				minSpawnBudget: 20.0,
				threatGrowthEscalationRate: 0.1,
			},
		})

		this.createEntity(payload)

		// --- Define and pre-compile all spawnable enemies ---
		this.spawnableEnemies = [
			{ prefabName: 'spinner', cost: 5, weight: 10 },
			// { prefabName: 'splody', cost: 15, weight: 2 }, // Example for when 'splody' is ready
		]

		// Pre-compile payloads for all spawnable enemies for efficient spawning.
		for (const enemy of this.spawnableEnemies) {
			try {
				const { payload, mutators } = this.compile(enemy.prefabName)
				enemy.payload = payload
				enemy.mutators = mutators
			} catch (e) {
				console.error(`DirectorSystem: Failed to compile prefab "${enemy.prefabName}". It will not be spawned.`, e)
			}
		}
		// Filter out any enemies that failed to compile.
		this.spawnableEnemies = this.spawnableEnemies.filter(e => e.payload)

		// Get access to the spatial hash grid for finding empty spawn locations.
		const gridSABs = physicsManager.getSpatialHashGridSABs()
		this.grid = new SpatialHashGrid(gridSABs)
		// A reusable Set to avoid allocations in the update loop.
		this.foundEntities = new Set()
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
			console.warn('DirectorSystem: Could not find an empty spot to spawn wave. Skipping wave, budget not spent.')
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
		const playerPosition = this.getComponent(this.playerId, position)
		if (!playerPosition) return null

		const { x: playerX, y: playerY } = playerPosition
		const screen = gameManager.getApp().screen

		const MAX_SPAWN_ATTEMPTS = 10
		const WAVE_CLUSTER_RADIUS = 200 // The radius of the area we need to be empty.
		// The distance from the player to search for a spawn point, ensuring it's off-screen.
		const searchRadius = Math.sqrt(screen.width ** 2 + screen.height ** 2) / 2 + WAVE_CLUSTER_RADIUS

		for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
			const randomAngle = Math.random() * 2 * Math.PI
			const x = playerX + searchRadius * Math.cos(randomAngle)
			const y = playerY + searchRadius * Math.sin(randomAngle)

			this.foundEntities.clear()
			this.grid.queryRadius(x, y, WAVE_CLUSTER_RADIUS, this.foundEntities)

			if (this.foundEntities.size === 0) {
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

		for (let i = 0; i < enemiesToSpawn.length; i++) {
			const enemyInfo = enemiesToSpawn[i]

			// Use a Fibonacci spiral (sunflower) pattern for natural-looking distribution.
			const radius = Math.sqrt(i + 0.5) * separation
			const angle = 2 * Math.PI * i * phi

			const enemyX = location.x + radius * Math.cos(angle)
			const enemyY = location.y + radius * Math.sin(angle)

			enemyInfo.mutators.position.x[0] = enemyX
			enemyInfo.mutators.position.y[0] = enemyY
			// This is the critical fix: we must set the dirtyTick for the SpriteDescriptor
			// so that the SpriteFactorySystem will process this newly created entity on the next frame.
			enemyInfo.mutators.spriteDescriptor.dirtyTick[0] = currentTick + 1

			this.createEntity(enemyInfo.payload)
		}
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
			let weightSum = 0, chosenEnemy = null
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
