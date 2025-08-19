const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { ComponentA, ComponentB } = componentManager.getComponents()

/**
 * @fileoverview A system for stress-testing structural changes (adding/removing components).
 *
 * ### Purpose
 * This benchmark measures the engine's ability to handle a high volume of structural
 * changes every frame. It simulates a scenario where many entities frequently change
 * their component composition, such as gaining or losing status effect components. This is
 * one of the most demanding operations for an ECS.
 *
 * ### What It Stresses
 * This system creates a "ping-pong" effect, moving thousands of entities back and forth
 * between two archetypes (`{ComponentA}` and `{ComponentA, ComponentB}`). This heavily tests:
 *
 * 1.  **`CommandBuffer`**: Its ability to efficiently group thousands of `addComponent` and
 *     `removeComponent` commands into large, homogeneous batches for a single transition.
 *
 * 2.  **`ArchetypeManager.moveEntitiesInBatch`**: This is the central orchestration method
 *     for structural changes and is put under maximum load.
 *
 * 3.  **`Archetype.addEntitiesByCopyingBatch`**: The performance of this method is critical.
 *     For each entity in the batch, it must copy the data for **all** of its components
 *     from the source archetype's arrays to the destination archetype's arrays.
 *
 * 4.  **`Archetype.compactAndRemove`**: After the move, the source archetype is full of
 *     "holes". This method's performance in compacting the remaining data is also tested.
 *
 * 5.  **Memory Allocation**: The process can trigger re-allocation of an archetype's
 *     `TypedArray`s if its capacity is exceeded, which is a very expensive operation.
 */
export class StructuralChangeBenchmarkSystem {
	constructor() {
		// Query for entities that have A but not B.
		this.addQuery = queryManager.getQuery({
			with: [ComponentA],
			without: [ComponentB],
		})

		// Query for entities that have both A and B.
		this.removeQuery = queryManager.getQuery({
			with: [ComponentA, ComponentB],
		})

		this.componentATypeID = componentManager.getComponentTypeID(ComponentA)
		this.componentBTypeID = componentManager.getComponentTypeID(ComponentB)

		// Individual command approach
		// Goal: 20k entities
		// Current max: 15k
		this.entityCount = 15_000

		// Pre-cache the component map to avoid creating objects in the loop.
		this.creationMap = new Map([[this.componentATypeID, {}]])
	}

	init() {
		// Spawn the initial pool of entities with only ComponentA.
		for (let i = 0; i < this.entityCount; i++) {
			this.commands.createEntity(this.creationMap)
		}
	}

	update(deltaTime, currentTick) {
		if (currentTick % 2 === 0) {
			// Even tick: Add ComponentB to entities that don't have it.
			for (const chunk of this.addQuery.iter()) {
				for (const entityIndex of chunk) {
					this.commands.addComponent(chunk.archetype.entities[entityIndex], this.componentBTypeID, {})
				}
			}
		} else {
			// Odd tick: Remove ComponentB from entities that have it.
			for (const chunk of this.removeQuery.iter()) {
				for (const entityIndex of chunk) {
					this.commands.removeComponent(chunk.archetype.entities[entityIndex], this.componentBTypeID)
				}
			}
		}
	}
}
