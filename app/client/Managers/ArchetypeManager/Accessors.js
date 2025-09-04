/**
 * @fileoverview Defines high-performance accessors for component data within an archetype.
 *
 * ### Architectural Note: Performance vs. Convenience ("Friendly Path" vs. "Fast Path")
 *
 * This file, along with `Views.js`, implements the "Friendly Path" for component data access.
 * The accessors provide a convenient, object-oriented API (`accessor.get(index).property`)
 * which is excellent for game logic, UI systems, or any code where readability is a priority.
 *
 * For a detailed guide on choosing the right component schema type (`enum`, `bitmask`, etc.)
 * and how it affects the view API, see the documentation in `Views.js`.
 *
 *
 * #### The Fast Path
 *
 * For performance-critical systems that run every frame on thousands of entities
 * (e.g., Movement, Physics), the convenience of views comes with a small overhead from function calls.
 *
 * For maximum performance, core systems should use the "Fast Path" by accessing the
 * underlying `TypedArray`s directly from the archetype.
 *
 * **Fast Path Example:**
 * ```javascript
 * // In a system's update loop...
 * const positions = archetype.componentArrays[this.positionTypeID];
 * for (const entityIndex of chunk) {
 *     positions.x[entityIndex] += ...; // Direct, raw access.
 * }
 * ```
 */
const { InternedStringView, SoAComponentView } = await import(`${PATH_MANAGERS}/ArchetypeManager/Views.js`)

/**
 * A high-performance accessor for 'Cold' (AoS) data, scoped to a single Archetype.
 * It is created and reused by a Query during iteration.
 */
export class AoSArchetypeAccessor {
	constructor(archetypeManager, archetypeId, typeID) {
		// Directly access the archetype's data from the manager
		const archetype = archetypeManager.getArchetypeById(archetypeId)
		this._array = archetype.componentArrays[typeID]
	}
	get(entityIndex) {
		return this._array[entityIndex]
	}
}

/**
 * A high-performance accessor for 'Hot' (SoA) data, scoped to a single Archetype.
 * It is created and reused by a Query during iteration.
 */
export class SoAArchetypeAccessor {
	constructor(chunk, typeID) {
		// The 'chunk' parameter is a Chunk instance.
		const componentManager = chunk.archetype.componentManager
		const info = componentManager.componentInfo[typeID]
		this._propArrays = chunk.componentArrays[typeID] // Direct access

		//  The Flyweight Pattern Optimization 
		// A single, reusable view object is created here in the constructor.
		// This is the key to the "Friendly Path's" performance. Instead of allocating
		// a new view object for every entity in a loop, we reuse this one.
		// ! this is still terrible for performance tho, NEVER use accessors and views it in heavy loops
		this._view = new SoAComponentView(info, this._propArrays, componentManager.stringManager)
	}

	/**
	 * Gets a view pointed to the data for a specific entity.
	 * This method does NOT create a new view. It simply updates the internal index
	 * of the single, cached view object and returns it.
	 * @param {number} entityIndex - The index of the entity within the archetype.
	 * @returns {SoAComponentView} The reusable view, now pointing to the new entity's data.
	 */
	get(entityIndex) {
		this._view._index = entityIndex
		return this._view
	}
}
