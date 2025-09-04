const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { Position, Velocity, CreationDestructionTag, ComponentA } = componentManager.getComponents()

/**
 * Configuration to enable or disable specific creation/destruction benchmarks.
 */
const benchmarkConfig = {
	/** Tests continuous, per-entity creation and destruction. Simulates a "bad" approach. */
	runPerEntityChurn: false,
	/** Tests large, infrequent spikes of batch creation and query-based destruction. */
	runQueryBasedSpike: true,
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

		this.churnPoolSize = 20_000
		this.churnRate = 2_000

		this.churnCreationMap = new Map([
			[this.positionTypeID, { x: 0, y: 0 }],
			[this.velocityTypeID, { x: 0, y: 0 }],
			[this.tagTypeID, {}],
		])

		// --- Query-Based Spike Test ---
		this.spikeQuery = queryManager.getQuery({
			with: [ComponentA], // Use ComponentA as a tag for this test
		})

		this.spikePoolSize = 5_000

		this.spikeCreationMap = new Map([
			[this.positionTypeID, { x: 0, y: 0 }],
			[this.velocityTypeID, { x: 0, y: 0 }],
			[this.componentATypeID, {}],
		])
	}

	init() {
		if (benchmarkConfig.runPerEntityChurn) {
			this._spawnChurn(this.churnPoolSize)
		}
		if (benchmarkConfig.runQueryBasedSpike) {
			this._spawnSpike(this.spikePoolSize)
		}
	}

	update(deltaTime, currentTick) {
		if (benchmarkConfig.runPerEntityChurn) {
			this._updateChurn()
		}
		if (benchmarkConfig.runQueryBasedSpike) {
			this._updateSpike(currentTick)
		}
	}

	// --- Per-Entity Churn Logic ---

	_updateChurn() {
		let destroyedCount = 0
		destructionLoop: for (const chunk of this.churnQuery.iter()) {
			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (destroyedCount >= this.churnRate) {
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
			this._spawnSpike(this.spikePoolSize)
		}
	}

	_spawnSpike(count) {
		if (count === 0) return
		// Use the hyper-optimized batch creation command.
		this.commands.createEntities(this.spikeCreationMap, count)
	}
}
