const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager } = ecs
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

/**
 * A single-threaded, purely CPU-bound benchmark.
 * This system performs the same calculations as ParallelCPUBenchmark but runs
 * entirely on the main thread within the `update` loop. It serves as a baseline
 * to measure the overhead of the parallel scheduler.
 */
export class CPUBenchmark {
	static dependencies = {
		update: {
			reads: ['velocity'],
			writes: ['position'],
		},
	}

	constructor() {
		const { position, velocity, cpuTag } = ecs.getTypeIDs()
		Object.assign(this, { position, velocity, cpuTag })

		this.query = queryManager.getQuery({
			with: [position, velocity, cpuTag],
		})

		this.entityCount = 2_000

		const { payload } = payloadCompiler.compileEntity({
			position: { x: 0.1, y: 0.2 },
			velocity: { x: 0.3, y: 0.4 },
			cpuTag: {},
		})

		this.creationPayload = payload
	}

	init() {
		this.spawnEntities()
	}

	update(context) {
		for (const chunk of this.query.iter()) {
			const positions = chunk.componentData[this.position]
			const velocities = chunk.componentData[this.velocity]

			for (let i = 0; i < chunk.size; i++) {
				// Read initial state once
				let x = positions.x[i]
				let y = velocities.y[i]

				// Perform a lot of computation.
				for (let j = 0; j < 50; j++) {
					const newX = Math.sin(x) * y - Math.cos(y) * x
					const newY = Math.cos(x) * y + Math.sin(y) * x
					x = newX
					y = newY
				}

				// Write the final result once
				positions.x[i] = x
			}
			chunk.markAllDirty(this.position, context.currentTick)
		}
	}

	spawnEntities() {
		this.commands.createEntities(this.creationPayload, this.entityCount)
	}

	destroy() {
		for (const chunk of this.query.iter()) {
			if (chunk.size > 0) this.commands.destroyEntitiesInChunk(chunk)
		}
	}
}
