const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()

const { Position, Velocity, RWMTag } = componentManager.getComponents()

/**
 * @fileoverview A system for stress-testing the core ECS data processing logic
 * (querying and component updates) without any rendering or structural change overhead.
 *
 * ### Purpose
 * This benchmark measures the absolute maximum data processing throughput of the engine.
 * It answers the question: "How many components can we read from and write to per frame?"
 * This is a measure of the engine's "hot loop" performance, which is critical for
 * gameplay systems that perform calculations on large numbers of entities.
 *
 * ### What It Stresses
 * This system is designed to be as close as possible to the ideal CPU-bound workload.
 * It heavily tests:
 *
 * 1.  **`QueryManager`**: The efficiency of iterating through archetypes and chunks
 *     (`query.iter()`).
 *
 * 2.  **`Archetype` Data Layout**: The performance of accessing component data directly
 *     from the underlying `TypedArray`s. This bypasses accessor/view overhead and is
 *     the fastest possible data access path, making it ideal for measuring the raw
 *     performance of the SoA (Struct-of-Arrays) layout.
 *
 * 3.  **JavaScript JIT Compiler**: The inner loop is written to be highly optimizable.
 *     Because it's a simple loop over contiguous `TypedArray`s, modern JS engines
 *     can often apply SIMD (Single Instruction, Multiple Data) vectorization, processing
 *     multiple entities in a single CPU instruction.
 */
export class RWMBenchmark {
	constructor() {
		this.query = queryManager.getQuery({
			with: [Position, Velocity, RWMTag],
		})
		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.benchmarkTagTypeID = componentManager.getComponentTypeID(RWMTag)

		//goal 1m
		//current max 1.1m stable
		this.entityCount = 1_000_000

		// Pre-cache the component map to avoid creating millions of objects during spawn.
		this.creationMap = new Map([
			[this.positionTypeID, { x: 0, y: 0 }],
			[this.velocityTypeID, { x: 10, y: 10 }],
			[this.benchmarkTagTypeID, {}],
		])
	}

	init() {
		this.spawnEntities()
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const archetype = chunk.archetype
			// Get a pre-initialized, cached dirty marker for this archetype.
			// This is extremely cheap and performs the expensive archetype-level tick update once.
			const positionMarker = archetypeManager.getDirtyMarker(archetype.id, this.positionTypeID, currentTick)

			// --- High-Performance Path: Direct TypedArray Access ---
			// Instead of using accessors and views (which involve function calls for each property access),
			// we get direct references to the underlying TypedArrays for each component property.
			// This is the absolute fastest way to process data in an SoA layout.
			const positions = archetype.componentArrays[this.positionTypeID]
			const velocities = archetype.componentArrays[this.velocityTypeID]

			// --- JIT Optimization: Hoisting Property Access ---
			// By declaring these constants outside the tight loop, we explicitly give the JIT
			// compiler a direct reference to the underlying TypedArrays. This is a critical
			// performance pattern for two reasons:
			// 1.  **Hot Paths**: For frequently executed loops like this one, it guarantees that
			//     the JIT compiler can perform its best optimizations (like SIMD).
			// 2.  **Cold Paths**: For code that runs infrequently (e.g., in a reactive system
			//     or a system on a timer), the JIT may not apply its full optimization power.
			//     In these cases, this pattern avoids the small but real overhead of repeated
			//     property lookups (`positions.x`) inside the loop.
			const posX = positions.x
			const posY = positions.y
			const velX = velocities.x
			const velY = velocities.y

			for (const entityIndex of chunk) {
				// This loop now performs only direct memory reads/writes on contiguous arrays,
				// which is extremely fast and allows the JS engine to apply SIMD optimizations.
				posX[entityIndex] += velX[entityIndex] * deltaTime
				posY[entityIndex] += velY[entityIndex] * deltaTime
				// The marker.mark() call is extremely cheap - just a single array write.
				positionMarker.mark(entityIndex)
			}
		}
	}

	spawnEntities() {
		console.log(`RWMBenchmark (SoA): Spawning ${this.entityCount} entities...`)
		this.commands.createEntities(this.creationMap, this.entityCount)
		console.log(`RWMBenchmark (SoA): Finished queueing ${this.entityCount} entities for creation.`)
	}
}
