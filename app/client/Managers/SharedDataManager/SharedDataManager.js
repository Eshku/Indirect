import * as Schema from '../../ECS/ComponentManager/ComponentSchema.js'

const INITIAL_CAPACITY = 1024

/**
 * Manages shared, de-duplicated component data using the "Indexed Indirection" pattern.
 *
 * This manager stores shared primitive properties (e.g., a cooldown's duration) in tightly
 * packed `TypedArray`s. Instead of storing the data itself, a component on an entity
 * stores a lightweight `u32` handle. This handle is used as a direct index into this
 * manager's arrays to retrieve the shared value.
 *
 * This approach provides two key benefits:
 * 1.  **No Archetype Fragmentation**: Entities with different shared data values can live
 *     in the same archetype, keeping chunks large and iteration fast.
 * 2.  **High Performance**: Accessing shared data is a simple, cache-friendly O(1) array lookup.
 */
export class SharedDataManager {
	constructor() {}

	init(ecs) {
		this.componentManager = ecs.componentManager
	}
}
