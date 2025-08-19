const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { Position, Velocity, CreationDestructionTag } = componentManager.getComponents()

/**
 * @fileoverview A system for stress-testing entity creation and destruction performance.
 *
 * ### Purpose
 * This benchmark measures the engine's throughput for creating and destroying large
 * quantities of entities every frame. This is a critical metric for games with dynamic
 * populations, such as those with many projectiles, particle effects, or frequently
 * spawning/despawning enemies.
 *
 * ### What It Stresses
 * This system is a worst-case scenario for the engine's structural change machinery.
 * It heavily tests:
 *
 * 1.  **`CommandBuffer`**: Its ability to efficiently consolidate and flush tens of
 *     thousands of `createEntity` and `destroyEntity` commands without generating
 *     excessive garbage that would lead to GC stalls.
 *
 * 2.  **`EntityManager`**: The speed of its entity ID allocation and recycling (`freeIDs`).
 *
 * 3.  **`ArchetypeManager` & `Archetype`**:
 *     - **Creation**: The cost of allocating space in component arrays. If an archetype's
 *       capacity is exceeded, this triggers a resize of all its `TypedArray`s, which is expensive.
 *     - **Destruction**: The performance of the `compactAndRemove` method. This involves
 *       a multi-swap-and-pop operation to fill the "holes" left by destroyed entities,
 *       which requires copying a significant amount of component data. This is often the
 *       primary bottleneck in high-churn scenarios.
 */
export class CreationDestructionBenchmarkSystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [CreationDestructionTag],
		})

		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.tagTypeID = componentManager.getComponentTypeID(CreationDestructionTag)

		//current max - 50k / 6k stable

		this.poolSize = 50_000 // Total number of entities to maintain in the pool.
		this.churnRate = 6_000 // Number of entities to create/destroy each frame.
		//a bit sad tbh

		// Pre-create the component map to avoid creating 5000+ new objects every frame.
		// This significantly reduces garbage collection pressure.
		this.creationMap = new Map([
			[this.positionTypeID, { x: 0, y: 0 }],
			[this.velocityTypeID, { x: 0, y: 0 }],
			[this.tagTypeID, {}],
		])
	}

	init() {
		// Spawn the initial pool of entities.
		this._spawn(this.poolSize)
	}

	update() {
		// 1. Destroy a number of entities from the pool.
		let destroyedCount = 0
		destructionLoop: for (const chunk of this.query.iter()) {
			for (const entityIndex of chunk) {
				if (destroyedCount >= this.churnRate) {
					break destructionLoop
				}
				this.commands.destroyEntity(chunk.archetype.entities[entityIndex])
				destroyedCount++
			}
		}

		// 2. Create the same number of new entities to maintain the pool size.
		this._spawn(destroyedCount)
	}

	_spawn(count) {
		// Queue all creation commands using the pre-created map.
		for (let i = 0; i < count; i++) {
			this.commands.createEntity(this.creationMap)
		}
	}
}
