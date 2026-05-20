const { engine } = await import(`@client/Engine.js`)

const { ecs } = engine.getManagers()

const benchmarkConfig = {
	// Options: 'creation', 'creation_identical', 'creation_varied',
	// 'destruction', 'destruction_bulk',
	// 'structuralChange', 'structuralChangeBulk',
	// 'setData', 'setDataSilent'
	activeBenchmark: 'creation_varied',

	creation: {
		entityCount: 0,
		batchSize: 6_000, // 6k 
	},
	creation_identical: {
		entityCount: 0,
		batchSize: 50_000, //50 before, destruction spikes expected.
	},
	creation_varied: {
		entityCount: 0,
		batchSize: 35_000, // 7k before
	},
	destruction: {
		entityCount: 400_000,
		batchSize: 6_000, //6k before
	},
	destruction_bulk: {
		entityCount: 1_500_000,
		batchSize: 5, // basically free, until re-creation kicks in
	},
	structuralChange: {
		entityCount: 50_000,
		batchSize: 6_000, //6k
	},
	structuralChangeBulk: {
		entityCount: 50_000,
		batchSize: 7_000,//7k+
	},
	setData: {
		entityCount: 100_000,
		batchSize: 6_000, //6k
	},
	setDataSilent: {
		entityCount: 100_000,
		batchSize: 6_000, // slightly faster then non-silent.
	},
}

const { position, velocity, componentA, componentB, commandBufferBenchmarkTag } = ecs.getComponentIDs()

export class EntityCommandBufferBenchmarkSystem {
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
		// This payload is used for initial population of most benchmarks, which can be very large.
		// We must compile it with a capacity large enough for the biggest benchmark's entityCount.
		const maxEntityCount = Math.max(
			benchmarkConfig.destruction.entityCount,
			benchmarkConfig.destruction_bulk.entityCount,
			benchmarkConfig.structuralChange.entityCount,
			benchmarkConfig.structuralChangeBulk.entityCount,
			benchmarkConfig.setData.entityCount,
			benchmarkConfig.setDataSilent.entityCount,
		)
		this.creationPayload = this.compile(
			{
				commandBufferBenchmarkTag: {},
				componentA: {},
				position: { x: 1, y: 2 },
				velocity: { x: 3, y: 4 },
			},
			{ count: maxEntityCount },
		)

		this.addComponentPayload = this.compile(
			{ componentB: {} },
			{ count: benchmarkConfig.structuralChange.batchSize },
		)

		// 'set' payload is also pre-compiled. We will use its mutators in the loop.
		this.setComponentPayload = this.compile({ position: { x: 99, y: 99 } }, { count: benchmarkConfig.setData.batchSize })
		this.setComponentMutators = this.setComponentPayload.buffers

		// 'set' silent payload is also pre-compiled. We will use its mutators in the loop.
		this.silentSetComponentPayload = this.compile(
			{ position: { x: 100, y: 100 } },
			{ count: benchmarkConfig.setDataSilent.batchSize },
		)
		this.silentSetComponentMutators = this.silentSetComponentPayload.buffers

		// --- Varied Creation Payload (new API) ---
		const variedConfig = benchmarkConfig.creation_varied
		this.varyingCreationPayload = this.compile(
			{
				commandBufferBenchmarkTag: {},
				componentA: {},
				position: {}, // We will vary this one
				velocity: { x: 3, y: 4 },
			},
			{ count: variedConfig.batchSize },
		)

		// --- State ---
		this.isAdding = true // For structural change benchmark

		if (
			benchmarkConfig.activeBenchmark !== 'creation' &&
			benchmarkConfig.activeBenchmark !== 'creation_identical' &&
			benchmarkConfig.activeBenchmark !== 'creation_varied'
		) {
			const config = benchmarkConfig[benchmarkConfig.activeBenchmark]
			this.instantiate(this.creationPayload, config.entityCount)
		}
	}

	update({ deltaTime }) {
		switch (benchmarkConfig.activeBenchmark) {
			case 'creation':
				this._updateCreation()
				break
			case 'creation_identical':
				this._updateCreationIdentical()
				break
			case 'creation_varied':
				this._updateCreationVaried()
				break
			case 'destruction':
				this._updateDestruction()
				break
			case 'destruction_bulk':
				this._updateDestructionBulk()
				break
			case 'structuralChange':
				this._updateStructuralChange()
				break
			case 'structuralChangeBulk':
				this._updateStructuralChangeBulk()
				break
			case 'setData':
				this._updateSetData()
				break
			case 'setDataSilent':
				this._updateSetDataSilent()
				break
		}
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
			this.instantiate(this.creationPayload)
		}
	}

	_updateCreationIdentical() {
		const config = benchmarkConfig.creation_identical
		// Destroy all entities from the previous frame and create a new batch.
		const chunkIds = this.benchmarkQuery.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			if (this.getChunkSize(chunkId) > 0) this.destroyEntitiesInChunk(chunkId)
		}
		this.instantiate(this.creationPayload, config.batchSize)
	}

	_updateCreationVaried() {
		const config = benchmarkConfig.creation_varied
		// Destroy all entities from the previous frame and create a new batch.
		const chunkIds = this.benchmarkQuery.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			if (this.getChunkSize(chunkId) > 0) this.destroyEntitiesInChunk(chunkId)
		}
		// New implementation: mutate the pre-compiled payload's buffers before instantiating.
		for (let i = 0; i < config.batchSize; i++) {
			this.varyingCreationPayload.buffers.position.x[i] = Math.random() * 100
			this.varyingCreationPayload.buffers.position.y[i] = Math.random() * 100
		}
		this.instantiate(this.varyingCreationPayload, config.batchSize)
	}

	_updateDestruction() {
		const config = benchmarkConfig.destruction
		// Create entities to replace the ones destroyed in the previous frame.
		this.instantiate(this.creationPayload, config.batchSize)

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

	_updateDestructionBulk() {
		const config = benchmarkConfig.destruction_bulk
		// Ensure we have enough entities to destroy.
		const currentCount = this.benchmarkQuery.count
		if (currentCount < config.entityCount / 2) {
			this.instantiate(this.creationPayload, config.entityCount - currentCount)
		}

		// Destroy a number of full chunks per frame as defined by batchSize.
		const chunkIds = this.benchmarkQuery.getChunks()
		for (let i = 0; i < config.batchSize; i++) {
			if (i >= chunkIds.length) break // Stop if we run out of chunks to destroy.
			const chunkToDestroy = chunkIds[i]
			if (this.getChunkSize(chunkToDestroy) > 0) this.destroyEntitiesInChunk(chunkToDestroy)
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

	_updateStructuralChangeBulk() {
		const config = benchmarkConfig.structuralChangeBulk

		if (this.isAdding) {
			const entities = Array.from(
				this.addQuery
					.getChunks()
					.flatMap(chunkId => Array.from(this.getEntities(chunkId).slice(0, this.getChunkSize(chunkId)))),
			).slice(0, config.batchSize)

			if (entities.length > 0) {
				this.addComponentsToEntities(entities, this.addComponentPayload)
			}

			if (entities.length < config.batchSize) {
				this.isAdding = false
			}
		} else {
			const entities = Array.from(
				this.removeQuery
					.getChunks()
					.flatMap(chunkId => Array.from(this.getEntities(chunkId).slice(0, this.getChunkSize(chunkId)))),
			).slice(0, config.batchSize)

			if (entities.length > 0) {
				this.removeComponentsFromEntities(entities, [componentB])
			}

			if (entities.length < config.batchSize) {
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

	_updateSetDataSilent() {
		const config = benchmarkConfig.setDataSilent
		// Mutate the payload's data directly before issuing commands.
		// This simulates a real-world scenario where data changes each frame.
		this.silentSetComponentMutators.position.x[0] = Math.random() * 100
		this.silentSetComponentMutators.position.y[0] = Math.random() * 100

		let processedCount = 0
		const chunkIds = this.benchmarkQuery.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const entities = this.getEntities(chunkId)
			for (let j = 0; j < this.getChunkSize(chunkId); j++) {
				if (processedCount >= config.batchSize) break
				this.setComponentSilent(entities[j], this.silentSetComponentPayload)
				processedCount++
			}
			if (processedCount >= config.batchSize) break
		}
	}
}
