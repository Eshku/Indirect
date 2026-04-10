const { engine } = await import(`@client/Engine.js`)

const { ecs } = engine.getManagers()

//! this won't do.

const benchmarkConfig = {
	// Options: 'creation', 'destruction', 'structuralChange', 'setData'
	activeBenchmark: 'structuralChange',

	creation: {
		entityCount: 0, // Not used for this test as it starts with an empty world.
		batchSize: 4_000, //4k after JiT.
		// using slow path for both creation and destruction, measuring worst cases for both
	},
	destruction: {
		entityCount: 400_000,
		batchSize: 5_000, //5k
	},
	structuralChange: {
		entityCount: 50_000,
		batchSize: 4_000, //4k
	},
	setData: {
		entityCount: 100_000,
		batchSize: 7_500, //7k+
	},
}

const { position, velocity, componentA, componentB, commandBufferBenchmarkTag } = ecs.getComponentIDs()

/**
 * A system to benchmark the raw throughput of the CommandBuffer for various operations.
 * This measures the time to both record commands and for the CommandBufferExecutor to process them.
 */
export class CommandBufferBenchmarkSystem {
	static dependencies = {
		update: {
			reads: [commandBufferBenchmarkTag, componentA, componentB, position],
		},
	}

	init() {
		// --- Queries ---
		this.benchmarkQuery = this.getQuery({ with: [commandBufferBenchmarkTag] })
		this.addQuery = this.getQuery({ with: [commandBufferBenchmarkTag, componentA], without: [componentB] })
		this.removeQuery = this.getQuery({ with: [commandBufferBenchmarkTag, componentA, componentB] })

		// --- Payloads ---
		this.creationPayload = this.compile({
			commandBufferBenchmarkTag: {},
			componentA: {},
			position: { x: 1, y: 2 },
			velocity: { x: 3, y: 4 },
		}).payload

		this.addComponentPayload = this.compile(componentB, {}).payload

		// 'set' payload is also pre-compiled. We will use its mutators in the loop.
		const { payload, mutators } = this.compile(position, { x: 99, y: 99 })
		this.setComponentPayload = payload
		this.setComponentMutators = mutators

		// --- State ---
		this.isAdding = true // For structural change benchmark

		if (benchmarkConfig.activeBenchmark !== 'creation') {
			const config = benchmarkConfig[benchmarkConfig.activeBenchmark]
			this.createEntities(this.creationPayload, config.entityCount)
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

		this.flush()
	}

	_updateCreation() {
		const config = benchmarkConfig.creation
		// Destroy all entities from the previous frame and create a new batch.
		const chunkIds = this.benchmarkQuery.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			if (this.getChunkSize(chunkId) > 0) this.destroyEntitiesInChunk(chunkId)
		}
		for (let i = 0; i < config.batchSize; i++) {
			// This part remains the same
			this.createEntity(this.creationPayload)
		}
	}

	_updateDestruction() {
		const config = benchmarkConfig.destruction
		// Create entities to replace the ones destroyed in the previous frame.
		this.createEntities(this.creationPayload, config.batchSize)

		let destroyedCount = 0
		const chunkIds = this.benchmarkQuery.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const entities = this.getEntities(chunkId)
			for (let j = 0; j < this.getChunkSize(chunkId); j++) {
				if (destroyedCount >= config.batchSize) break
				this.destroyEntity(entities[j])
				destroyedCount++
			}
			if (destroyedCount >= config.batchSize) break
		}
	}

	_updateStructuralChange() {
		const config = benchmarkConfig.structuralChange
		if (this.isAdding) {
			let processedCount = 0
			const chunkIds = this.addQuery.getChunks()
			for (let i = 0; i < chunkIds.length; i++) {
				const chunkId = chunkIds[i]
				const entities = this.getEntities(chunkId)
				for (let j = 0; j < this.getChunkSize(chunkId); j++) {
					if (processedCount >= config.batchSize) break
					this.addComponent(entities[j], this.addComponentPayload)
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
			const chunkIds = this.removeQuery.getChunks()
			for (let i = 0; i < chunkIds.length; i++) {
				const chunkId = chunkIds[i]
				const entities = this.getEntities(chunkId)
				for (let j = 0; j < this.getChunkSize(chunkId); j++) {
					if (processedCount >= config.batchSize) break
					this.removeComponent(entities[j], componentB)
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
		const chunkIds = this.benchmarkQuery.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const entities = this.getEntities(chunkId)
			for (let j = 0; j < this.getChunkSize(chunkId); j++) {
				if (processedCount >= config.batchSize) break
				this.setComponent(entities[j], this.setComponentPayload)
				processedCount++
			}
			if (processedCount >= config.batchSize) break
		}
	}
}
