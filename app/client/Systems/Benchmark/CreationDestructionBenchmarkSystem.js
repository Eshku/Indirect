const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

//! system itself is pretty heavy
const benchmarkConfig = {
	// true / false
	runPerEntityChurn: true, // Creates/destroys N entities per frame, one by one.
	runQueryBasedChurn: false, // Creates/destroys N entities per frame using batch commands.
	runPrefabChurn: false, // Creates/destroys N entities per frame using prefab instantiation.

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
		const { creationDestructionTag, position, velocity, componentB, testEntityTag } = componentManager.getTypeIDs();
		Object.assign(this, { creationDestructionTag, position, velocity, componentB, testEntityTag });

		// --- Per-Entity Churn Test ---
		this.churnQuery = queryManager.getQuery({
			with: [creationDestructionTag],
		})

		// --- Prefab Churn Test ---
		this.prefabChurnQuery = queryManager.getQuery({
			with: [testEntityTag],
			without: [creationDestructionTag, componentB], // Ensure queries are mutually exclusive
		})

		// --- Query-Based Churn Test ---
		this.churnQueryBased = queryManager.getQuery({
			with: [componentB], // Use componentB as a tag for this test
		})

		// Use the high-level compiler API that automatically determines the archetype.
		// This is the correct, convenient pattern for systems.
		this.churnBasedPayload = payloadCompiler.compileEntities({
			position: { x: 0, y: 0 },
			velocity: { x: 0, y: 0 },
			componentB: {},
		}).payload

		this.perEntityChurnPayload = payloadCompiler.compileEntity({
			position: { x: 0, y: 0 },
			velocity: { x: 0, y: 0 },
			creationDestructionTag: {},
		}).payload

		// Pre-compile the prefab payload, including overrides if configured.
		const prefabOverrides = benchmarkConfig.prefabChurn.withOverrides ? { position: { x: 100, y: -100 } } : {}
		this.prefabChurnPayload = payloadCompiler.compileEntity('test_prefab', prefabOverrides).payload
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
			this.commands.createEntity(this.perEntityChurnPayload)
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
		for (let i = 0; i < count; i++) {
			this.commands.instantiate(this.prefabChurnPayload, 0)
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
