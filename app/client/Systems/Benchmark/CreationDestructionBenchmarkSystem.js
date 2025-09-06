const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { Position, Velocity, CreationDestructionTag, ComponentA, ComponentB } = componentManager.getComponents()

/**
 * Configuration to enable or disable specific creation/destruction benchmarks.
 */
const benchmarkConfig = {
	// true / false
	runPerEntityChurn: false, // Creates/destroys N entities per frame, one by one.
	runQueryBasedChurn: true, // Creates/destroys N entities per frame using batch commands.

	runQueryBasedSpike: false, // Creates/destroys a large pool of entities every few seconds.

	// --- Test-Specific Settings ---
	perEntityChurn: {
		poolSize: 20_000,
		churnRate: 2_000,
	},
	queryBasedChurn: {
		churnRate: 20_000, // How many to create/destroy each frame
	},
	queryBasedSpike: {
		poolSize: 50_000,
	},
}

/**
 * @fileoverview A consolidated system for stress-testing various entity creation and destruction patterns.
 */
export class CreationDestructionBenchmarkSystem {
	constructor() {
		// --- Per-Entity Churn Test ---
		this.churnQuery = queryManager.getQuery({
			with: [CreationDestructionTag],
			without: [ComponentA], // Ensure we don't touch spike test entities
		})

		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.tagTypeID = componentManager.getComponentTypeID(CreationDestructionTag)
		this.componentATypeID = componentManager.getComponentTypeID(ComponentA)
		this.componentBTypeID = componentManager.getComponentTypeID(ComponentB)

		this.churnCreationMap = new Map([
			[this.positionTypeID, { x: 0, y: 0 }],
			[this.velocityTypeID, { x: 0, y: 0 }],
			[this.tagTypeID, {}],
		])

		// --- Query-Based Spike Test ---
		this.spikeQuery = queryManager.getQuery({
			with: [ComponentA], // Use ComponentA as a tag for this test
		})

		this.spikeCreationMap = new Map([
			[this.positionTypeID, { x: 0, y: 0 }],
			[this.velocityTypeID, { x: 0, y: 0 }],
			[this.componentATypeID, {}],
		])

		// --- Query-Based Churn Test ---
		this.churnQueryBased = queryManager.getQuery({
			with: [ComponentB], // Use ComponentB as a tag for this test
		})

		this.churnBasedCreationMap = new Map([
			[this.positionTypeID, { x: 0, y: 0 }],
			[this.velocityTypeID, { x: 0, y: 0 }],
			[this.componentBTypeID, {}],
		])
	}

	init() {
		if (benchmarkConfig.runPerEntityChurn) {
			this._spawnChurn(benchmarkConfig.perEntityChurn.poolSize)
		}
		if (benchmarkConfig.runQueryBasedSpike) {
			this._spawnSpike(benchmarkConfig.queryBasedSpike.poolSize)
		}
	}

	update(deltaTime, currentTick) {
		if (benchmarkConfig.runPerEntityChurn) {
			this._updateChurn()
		}
		if (benchmarkConfig.runQueryBasedSpike) {
			this._updateSpike(currentTick)
		}
		if (benchmarkConfig.runQueryBasedChurn) {
			this._updateQueryBasedChurn()
		}
	}

	// --- Per-Entity Churn Logic ---

	_updateChurn() {
		let destroyedCount = 0
		destructionLoop: for (const chunk of this.churnQuery.iter()) {
			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (destroyedCount >= benchmarkConfig.perEntityChurn.churnRate) {
					break destructionLoop
				}
				this.commands.destroyEntity(chunk.entities[indexInChunk])
				destroyedCount++
			}
		}
		this._spawnChurn(destroyedCount)
	}

	_spawnChurn(count) {
		for (let i = 0; i < count; i++) {
			// This is the "bad" approach, queuing one command per entity.
			this.commands.createEntity(this.churnCreationMap)
		}
	}

	// --- Query-Based Spike Logic ---

	_updateSpike(currentTick) {
		// Every 120 ticks (2 seconds), destroy and then respawn the entire pool.
		if (currentTick > 0 && currentTick % 120 === 0) {
			// Use a single, high-level command to destroy all matching entities.
			this.commands.destroyEntitiesInQuery(this.spikeQuery)
		} else if (currentTick > 0 && currentTick % 120 === 1) {
			// On the very next frame, respawn them all.
			this._spawnSpike(benchmarkConfig.queryBasedSpike.poolSize)
		}
	}

	_spawnSpike(count) {
		if (count === 0) return
		// Use the hyper-optimized batch creation command.
		this.commands.createEntities(this.spikeCreationMap, count)
	}

	// --- Query-Based Churn Logic ---

	_updateQueryBasedChurn() {
		// Destroy all entities from the previous frame.
		this.commands.destroyEntitiesInQuery(this.churnQueryBased)
		// Create a new batch for this frame.
		this.commands.createEntities(this.churnBasedCreationMap, benchmarkConfig.queryBasedChurn.churnRate)
	}
}
