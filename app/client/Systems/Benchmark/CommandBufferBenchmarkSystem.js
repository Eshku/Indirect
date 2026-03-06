const { engine } = await import(`${PATH_CLIENT}/Engine.js`)

const { ecs } = engine.getManagers()
const { entityManager, queryManager } = ecs
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

const benchmarkConfig = {
	// Select ONE benchmark to run by setting its name here.
	// Options: 'creation', 'destruction', 'structuralChange', 'setData'
	activeBenchmark: 'creation',

	//! add chunk-based commands to replace (now deleted) single-threaded query-based commands.

	creation: {
		entityCount: 0, // Not used for this test as it starts with an empty world.
		batchSize: 2_000, //2k
		//!using slow path for both creation and destruction, measuring worst cases for both
	},
	destruction: {
		entityCount: 100_000,
		batchSize: 5_000, //5k
	},
	structuralChange: {
		entityCount: 100_000,
		batchSize: 5_000, //5k+
	},
	setData: {
		entityCount: 100_000,
		batchSize: 5_000, //5k+
	},
}

const { position, velocity, componentA, componentB, commandBufferBenchmarkTag } = ecs.getTypeIDs()

/**
 * A system to benchmark the raw throughput of the CommandBuffer for various operations.
 * This measures the time to both record commands and for the CommandBufferExecutor to process them.
 */
export class CommandBufferBenchmarkSystem {
	static dependencies = {
		update: {
			// This system reads from multiple queries to find entities to modify via commands.
			// We must declare all components it could possibly read to ensure it runs after
			// they have been written to by other systems.

			reads: [commandBufferBenchmarkTag, componentA, componentB, position],
		},
	}
	constructor() {
		// --- Queries ---
		this.benchmarkQuery = queryManager.getQuery({ with: [commandBufferBenchmarkTag] })
		this.addQuery = queryManager.getQuery({ with: [commandBufferBenchmarkTag, componentA], without: [componentB] })
		this.removeQuery = queryManager.getQuery({ with: [commandBufferBenchmarkTag, componentA, componentB] })

		// --- Payloads ---
		this.creationPayload = payloadCompiler.compileEntity({
			commandBufferBenchmarkTag: {},
			componentA: {},
			position: { x: 1, y: 2 },
			velocity: { x: 3, y: 4 },
		}).payload

		this.addComponentPayload = payloadCompiler.compileComponent(componentB, {}).payload

		// 'set' payload is also pre-compiled. We will use its mutators in the loop.
		const { payload, mutators } = payloadCompiler.compileComponent(position, { x: 99, y: 99 })
		this.setComponentPayload = payload
		this.setComponentMutators = mutators

		// --- State ---
		this.isAdding = true // For structural change benchmark
	}

	init() {
		if (benchmarkConfig.activeBenchmark !== 'creation') {
			const config = benchmarkConfig[benchmarkConfig.activeBenchmark]
			this.commands.createEntities(this.creationPayload, config.entityCount)
		}
	}

	update({ deltaTime, currentTick }) {
		switch (benchmarkConfig.activeBenchmark) {
			case 'creation':
				this._updateCreation()
				break
			case 'destruction':
				this._updateDestruction()
				break
			case 'structuralChange':
				this._updateStructuralChange()
				break
			case 'setData':
				this._updateSetData()
				break
		}
	}

	_updateCreation() {
		const config = benchmarkConfig.creation
		// Destroy all entities from the previous frame and create a new batch.
		for (const chunk of this.benchmarkQuery.iter()) {
			if (chunk.size > 0) this.commands.destroyEntitiesInChunk(chunk)
		}
		for (let i = 0; i < config.batchSize; i++) {
			// This part remains the same
			this.commands.createEntity(this.creationPayload)
		}
	}

	_updateDestruction() {
		const config = benchmarkConfig.destruction
		// Create entities to replace the ones destroyed in the previous frame.
		this.commands.createEntities(this.creationPayload, config.batchSize)

		let destroyedCount = 0
		for (const chunk of this.benchmarkQuery.iter()) {
			for (let i = 0; i < chunk.size; i++) {
				if (destroyedCount >= config.batchSize) break
				this.commands.destroyEntity(chunk.entities[i])
				destroyedCount++
			}
			if (destroyedCount >= config.batchSize) break
		}
	}

	_updateStructuralChange() {
		const config = benchmarkConfig.structuralChange
		if (this.isAdding) {
			let processedCount = 0
			for (const chunk of this.addQuery.iter()) {
				for (let i = 0; i < chunk.size; i++) {
					if (processedCount >= config.batchSize) break
					this.commands.addComponent(chunk.entities[i], this.addComponentPayload)
					processedCount++
				}
				if (processedCount >= config.batchSize) break
			}
			// If we processed fewer than the batch size, it means we're done adding.
			if (processedCount < config.batchSize) {
				this.isAdding = false
			}
		} else {
			let processedCount = 0
			for (const chunk of this.removeQuery.iter()) {
				for (let i = 0; i < chunk.size; i++) {
					if (processedCount >= config.batchSize) break
					this.commands.removeComponent(chunk.entities[i], componentB)
					processedCount++
				}
				if (processedCount >= config.batchSize) break
			}
			// If we processed fewer than the batch size, it means we're done removing.
			if (processedCount < config.batchSize) {
				this.isAdding = true
			}
		}
	}

	_updateSetData() {
		const config = benchmarkConfig.setData
		// Mutate the payload's data directly before issuing commands.
		// This simulates a real-world scenario where data changes each frame.
		this.setComponentMutators.position.x[0] = Math.random() * 100
		this.setComponentMutators.position.y[0] = Math.random() * 100

		let processedCount = 0
		for (const chunk of this.benchmarkQuery.iter()) {
			for (let i = 0; i < chunk.size; i++) {
				if (processedCount >= config.batchSize) break
				this.commands.setComponentData(chunk.entities[i], this.setComponentPayload)
				processedCount++
			}
			if (processedCount >= config.batchSize) break
		}
	}
}
