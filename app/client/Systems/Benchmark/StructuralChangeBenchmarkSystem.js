const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)
/**
 * runPerEntity: Alternates adding/removing a component to every entity each frame. (JIT unfriendly)
 * runBatchedWave: Adds a component to a 'wave' of entities each frame until all have it, then removes it in waves. (JIT friendly)
 * runQueryBased: Uses a single command to add/remove a component to all entities in a query. (Measures command overhead)
 */
const benchmarkConfig = {
	// Select ONE benchmark to run by setting its name here.
	// Options: 'perEntity', 'batchedWave', 'queryBased'
	activeBenchmark: 'perEntity',

	// Config for the JIT-unfriendly benchmark that modifies all entities every frame.
	perEntity: {
		entityCount: 8_000, //6k max
	},

	// Config for the JIT-friendly benchmark that modifies entities in waves.
	//Expected to start slow, but then fire up optimizations.
	batchedWave: {
		entityCount: 1_000_000,
		waveSize: 5_000, // Number of entities to process per frame.
	},

	// Config for the benchmark that uses a single command to modify a whole query.
	queryBased: {
		entityCount: 70_000, //70k on the edge with SoA
	},

	enableVerificationLog: false, // Set to true to see periodic query size logs.
	//Frameskip can cause incorrect output.
}

/**
 * system for stress-testing structural changes (adding/removing components).
 */
export class StructuralChangeBenchmarkSystem {
	constructor() {
		const { componentA, componentB } = componentManager.getTypeIDs();
		Object.assign(this, { componentA, componentB });

		this.addQuery = queryManager.getQuery({
			with: [componentA],
			without: [componentB],
		})

		this.removeQuery = queryManager.getQuery({
			with: [componentA, componentB],
		})

		this.verificationInterval = 120 // Log every 2 seconds at 60tps.

		// State for the Batched Wave benchmark
		this.isAddingWave = true
		this.batchedWaveSize = benchmarkConfig.batchedWave.waveSize

		// Pre-compile the creation payload once for maximum efficiency.
		const { payload } = payloadCompiler.compileEntities({
			componentA: {},
		})
		this.creationPayload = payload

		// Pre-compile the payload for adding ComponentB. Since it's a tag, the data is empty.
		const { payload: addPayload } = payloadCompiler.compileComponent(this.componentB, {})
		this.addComponentPayload = addPayload
	}

	init() {
		let count = 0
		switch (benchmarkConfig.activeBenchmark) {
			case 'perEntity':
				count = benchmarkConfig.perEntity.entityCount
				break
			case 'batchedWave':
				count = benchmarkConfig.batchedWave.entityCount
				break
			case 'queryBased':
				count = benchmarkConfig.queryBased.entityCount
				break
		}

		for (let i = 0; i < count; i++) {
			this.commands.createEntity(this.creationPayload)
		}
	}

	update(deltaTime, currentTick) {
		if (benchmarkConfig.enableVerificationLog && currentTick > 0) {
			// Pre-operation check, happens on the verification tick itself.
			if (currentTick % this.verificationInterval === 0) {
				console.log(
					`%c[Benchmark Verification] Pre-operation check at tick ${currentTick}:`,
					'color: yellow; font-weight: bold;'
				)
				console.log(`> addQuery size: ${this._getQuerySize(this.addQuery)}`)
				console.log(`> removeQuery size: ${this._getQuerySize(this.removeQuery)}`)
			}

			// Post-operation check, happens on the tick *after* the verification tick.
			if ((currentTick - 1) % this.verificationInterval === 0 && currentTick > 1) {
				console.log(
					`%c[Benchmark Verification] Post-operation check at tick ${currentTick}:`,
					'color: cyan; font-weight: bold;'
				)
				console.log(`> addQuery size: ${this._getQuerySize(this.addQuery)}`)
				console.log(`> removeQuery size: ${this._getQuerySize(this.removeQuery)}`)
			}
		}

		switch (benchmarkConfig.activeBenchmark) {
			case 'perEntity':
				this._updatePerEntity(currentTick)
				break
			case 'batchedWave':
				this._updateBatchedWave()
				break
			case 'queryBased':
				this._updateQueryBased(currentTick)
				break
		}
	}

	_updatePerEntity(currentTick) {
		if (currentTick % 2 === 0) {
			for (const chunk of this.addQuery.iter()) {
				for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
					this.commands.addComponent(chunk.entities[indexInChunk], this.addComponentPayload)
				}
			}
		} else {
			for (const chunk of this.removeQuery.iter()) {
				for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
					this.commands.removeComponent(chunk.entities[indexInChunk], this.componentB)
				}
			}
		}
	}

	_updateBatchedWave() {
		if (this.isAddingWave) {
			let processedCount = 0
			for (const chunk of this.addQuery.iter()) {
				for (let i = 0; i < chunk.size; i++) {
					if (processedCount >= this.batchedWaveSize) break
					this.commands.addComponent(chunk.entities[i], this.addComponentPayload)
					processedCount++
				}
				if (processedCount >= this.batchedWaveSize) break
			}

			// If the addQuery is now empty, switch to the removing phase
			if (this._getQuerySize(this.addQuery) === 0) {
				this.isAddingWave = false
			}
		} else {
			let processedCount = 0
			for (const chunk of this.removeQuery.iter()) {
				for (let i = 0; i < chunk.size; i++) {
					if (processedCount >= this.batchedWaveSize) break
					this.commands.removeComponent(chunk.entities[i], this.componentB)
					processedCount++
				}
				if (processedCount >= this.batchedWaveSize) break
			}

			// If the removeQuery is now empty, switch back to the adding phase
			if (this._getQuerySize(this.removeQuery) === 0) {
				this.isAddingWave = true
			}
		}
	}

	_updateQueryBased(currentTick) {
		if (currentTick % 2 === 0) {
			this.commands.addComponentToQuery(this.addQuery, this.addComponentPayload)
		} else {
			this.commands.removeComponentFromQuery(this.removeQuery, this.componentB)
		}
	}

	_getQuerySize(query) {
		let count = 0
		for (const archetypeId of query.matchingArchetypeIds) {
			const chunks = archetypeManager.archetypeChunks[archetypeId]
			for (const chunk of chunks) {
				count += chunk.size
			}
		}
		return count
	}
}
