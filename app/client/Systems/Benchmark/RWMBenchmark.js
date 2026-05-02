const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { position, velocity, rwmTag } = ecs.getComponentIDs()

export class RWMBenchmark {
	static dependencies = {
		update: {
			reads: [velocity],
			writes: [position],
		},
	}

	init() {
		this.query = this.getQuery({
			with: [position, velocity, rwmTag],
		})

		//1.5m stable
		this.entityCount = 1_500_000

		this.creationPayload = this.compile(
			{
				position: { x: 0, y: 0 },
				velocity: { x: 10, y: 10 },
				rwmTag: {},
			},
			{ count: this.entityCount },
		)

		this.spawnEntities()
	}

	update({ deltaTime, currentTick }) {
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const positions = this.getComponentData(chunkId, position)
			const velocities = this.getComponentData(chunkId, velocity)
			const chunkSize = this.getChunkSize(chunkId)

			for (let j = 0; j < chunkSize; j++) {
				positions.x[j] += velocities.x[j] * deltaTime
				positions.y[j] += velocities.y[j] * deltaTime
			}

			// Since we modify every entity, mark the whole component type as dirty.
			this.markComponentDirty(chunkId, position, currentTick)
		}
	}

	spawnEntities() {
		console.log(`RWMBenchmark (SoA): Spawning ${this.entityCount} entities...`)
		this.instantiate(this.creationPayload, this.entityCount)
		console.log(`RWMBenchmark (SoA): Finished queueing ${this.entityCount} entities for creation.`)
	}

	destroy() {
		console.log(`[RWMBenchmark] Cleaning up ${this.entityCount} entities...`)
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			if (this.getChunkSize(chunkId) > 0) this.destroyEntitiesInChunk(chunkId)
		}
	}
}
