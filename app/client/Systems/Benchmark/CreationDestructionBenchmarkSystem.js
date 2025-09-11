const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()
const { payloadCompiler } = await import(`${PATH_CLIENT}/Managers/SystemManager/PayloadCompiler.js`)

//! ssytem itself is pretty heavy
const benchmarkConfig = {
	// true / false
	runPerEntityChurn: false, // Creates/destroys N entities per frame, one by one.
	runQueryBasedChurn: false, // Creates/destroys N entities per frame using batch commands.
	runPrefabChurn: true, // Creates/destroys N entities per frame using prefab instantiation.

	perEntityChurn: {
		poolSize: 20_000,
		churnRate: 2000,
	},
	queryBasedChurn: {
		churnRate: 25_000, // How many to create/destroy each frame
	},
	prefabChurn: {
		poolSize: 20_000,
		churnRate: 2_000,
		// Set to true to test instantiation with component data overrides.
		withOverrides: true,
	},
}

/**
 * consolidated system for stress-testing various entity creation and destruction patterns.
 */
export class CreationDestructionBenchmarkSystem {
	constructor() {
		const { CreationDestructionTag, Position, Velocity, ComponentB, TestEntityTag } = componentManager.getTypeIDs()

		// --- Per-Entity Churn Test ---
		this.churnQuery = queryManager.getQuery({
			with: [CreationDestructionTag],
		})

		// --- Prefab Churn Test ---
		this.prefabChurnQuery = queryManager.getQuery({
			with: [TestEntityTag],
			without: [CreationDestructionTag, ComponentB], // Ensure queries are mutually exclusive
		})

		this.positionTypeID = Position
		this.velocityTypeID = Velocity
		this.tagTypeID = CreationDestructionTag
		this.componentBTypeID = ComponentB

		// --- Query-Based Churn Test ---
		this.churnQueryBased = queryManager.getQuery({
			with: [ComponentB], // Use ComponentB as a tag for this test
		})

		const churnBasedCreationMap = new Map([
			[this.positionTypeID, { x: 0, y: 0 }],
			[this.velocityTypeID, { x: 0, y: 0 }],
			[this.componentBTypeID, {}],
		])

		this.churnBasedPayload = payloadCompiler.compileCreationPayload(
			archetypeManager.getArchetype(churnBasedCreationMap.keys()),
			churnBasedCreationMap
		)
	}

	init() {
		if (benchmarkConfig.runPerEntityChurn) {
			this._spawnChurn(benchmarkConfig.perEntityChurn.poolSize)
		}
		if (benchmarkConfig.runPrefabChurn) {
			this._spawnPrefabChurn(benchmarkConfig.prefabChurn.poolSize)
		}
		if (benchmarkConfig.runQueryBasedChurn) {
			// This benchmark starts with 0 entities and creates them in the update loop.
		}
	}

	update(deltaTime, currentTick) {
		if (benchmarkConfig.runPerEntityChurn) {
			this._updateChurn(currentTick)
		}
		if (benchmarkConfig.runPrefabChurn) {
			this._updatePrefabChurn(currentTick)
		}
		if (benchmarkConfig.runQueryBasedChurn) {
			this._updateQueryBasedChurn(currentTick)
		}
	}

	// --- Per-Entity Churn Logic ---

	_updateChurn(currentTick) {
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
			this.commands.createEntity({
				Position: { x: 0, y: 0 },
				Velocity: { x: 0, y: 0 },
				CreationDestructionTag: {},
			})
		}
	}

	// --- Prefab Churn Logic ---

	_updatePrefabChurn(currentTick) {
		let destroyedCount = 0
		destructionLoop: for (const chunk of this.prefabChurnQuery.iter()) {
			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				if (destroyedCount >= benchmarkConfig.prefabChurn.churnRate) {
					break destructionLoop
				}
				this.commands.destroyEntity(chunk.entities[indexInChunk])
				destroyedCount++
			}
		}
		this._spawnPrefabChurn(destroyedCount)
	}

	_spawnPrefabChurn(count) {
		const overrides = benchmarkConfig.prefabChurn.withOverrides ? { Position: { x: 100, y: -100 } } : {}
		for (let i = 0; i < count; i++) {
			this.commands.instantiate('test_prefab', overrides)
		}
	}

	// --- Query-Based Churn Logic ---

	_updateQueryBasedChurn() {
		// Destroy all entities from the previous frame.
		this.commands.destroyEntitiesInQuery(this.churnQueryBased)
		// Create a new batch for this frame.
		this.commands.createEntities(this.churnBasedPayload, benchmarkConfig.queryBasedChurn.churnRate)
	}
}
