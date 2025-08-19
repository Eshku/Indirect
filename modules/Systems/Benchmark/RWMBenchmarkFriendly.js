const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()

const { Position, Velocity, RWMTag } = componentManager.getComponents()

/**
 * @fileoverview A system for stress-testing the core ECS data processing logic
 * using the "Friendly Path" (Accessors and Views).
 *
 * ### Purpose
 * This benchmark measures the data processing throughput of the engine when using
 * the higher-level, more convenient API (`accessor.get(index).property`). It contrasts
 * with `RWMBenchmark.js`, which uses raw TypedArray access. This helps quantify the
 * overhead of the "Friendly Path" and is a measure of its "hot loop" performance.
 *
 * ### What It Stresses
 * This system is designed to test the efficiency of the view-based abstraction layer.
 * It heavily tests:
 *
 * 1.  **`QueryManager`**: The efficiency of iterating through archetypes and chunks
 *     (`query.iter()`), same as the raw benchmark.
 *
 * 2.  **`Archetype.getComponentAccessor`**: The overhead of retrieving a cached accessor
 *     for a component type within an archetype.
 *
 * 3.  **`SoAArchetypeAccessor.get`**: The core of the "flyweight" pattern. This method's
 *     performance is critical, as it's called for every entity. It updates the internal
 *     index of a single, reusable view object.
 *
 * 4.  **`SoAComponentView` Property Getters/Setters**: The overhead of the function calls
 *     for getting and setting properties on the view object. While these calls are simple
 *     and highly inlinable by the JIT, they still represent an overhead compared to
 *     direct memory access.
 */
export class RWMBenchmarkFriendly {
	constructor() {
		this.query = queryManager.getQuery({
			with: [Position, Velocity, RWMTag],
		})
		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.benchmarkTagTypeID = componentManager.getComponentTypeID(RWMTag)

		// this sucks
		this.entityCount = 40_000

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
			const archetypeData = chunk.archetype

			// --- Friendly Path: Using Accessors and Views ---
			// Get the accessors once per archetype. This is cheap as they are cached.
			const positionAccessor = archetypeManager.getComponentAccessor(archetypeData.id, this.positionTypeID)
			const velocityAccessor = archetypeManager.getComponentAccessor(archetypeData.id, this.velocityTypeID)
			const positionMarker = archetypeManager.getDirtyMarker(archetypeData.id, this.positionTypeID, currentTick)

			for (const entityIndex of chunk) {
				const position = positionAccessor.get(entityIndex)
				const velocity = velocityAccessor.get(entityIndex)

				position.x += velocity.x * deltaTime
				position.y += velocity.y * deltaTime

				positionMarker.mark(entityIndex)
			}
		}
	}

	spawnEntities() {
		console.log(`RWMBenchmark (Friendly): Spawning ${this.entityCount} entities...`)
		this.commands.createEntities(this.creationMap, this.entityCount)
		console.log(`RWMBenchmark (Friendly): Finished queueing ${this.entityCount} entities for creation.`)
	}
}