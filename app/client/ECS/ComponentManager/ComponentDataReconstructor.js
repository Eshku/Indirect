/**
 * A stateless service responsible for reconstructing "designer-friendly" component
 * data objects from the raw, engine-friendly data stored in chunks. This is the
 * single source of truth for all "read" path data transformations.
 *
 * ---
 * ### DEV-NOTE: The "Read" Authority
 * This service is the single authority for the **"Read Path"**. Its sole responsibility
 * is to take raw, engine-friendly numeric data from a `Chunk` and reconstruct it into a
 * high-level, "designer-friendly" JavaScript object. It is the symmetrical counterpart
 * to the `ComponentInterpreter`.
 */

const { stringInterningTable } = await import(`${PATH_INDIRECT}/StringInterningTable.js`)
import * as Schema from './ComponentSchema.js'
const { reconstruct: reconstructWithInterpreter } = await import('./ComponentInterpreter.js')

class ComponentDataReconstructor {
	constructor() {
		// This service is stateless.
		this.entityManager = null
	}

	init({ entityManager }) {
		this.entityManager = entityManager
	}

	/**
	 * Reconstructs a component's data for a given entity.
	 * This is the main entry point for the read path.
	 * @param {number} entityId The ID of the entity to read from.
	 * @param {number} typeID The component's type ID.
	 * @returns {object | undefined} The reconstructed component data, or undefined if not found.
	 */
	reconstruct(entityId, typeID) {
		const archetypeId = this.entityManager.getArchetypeForEntity(entityId)
		if (archetypeId === undefined || !this.entityManager.hasComponentType(archetypeId, typeID)) {
			return undefined
		}

		const location = this.entityManager.getEntityLocation(entityId)
		if (!location) return undefined

		const { chunk, indexInChunk } = location
		return this._reconstructFromChunk(chunk, indexInChunk, typeID)
	}

	/**
	 * Reconstructs a "designer-friendly" shared data object from its raw,
	 * engine-friendly format.
	 * @param {number} typeID The component's type ID.
	 * @param {object} rawSharedData The raw shared data object (e.g., `{ value: 13 }`).
	 * @returns {object} The reconstructed shared data (e.g., `{ value: 'common' }`).
	 */
	reconstructShared(typeID, rawSharedData) {
		// Delegate directly to the centralized interpreter.
		return reconstructWithInterpreter(typeID, rawSharedData)
	}

	_reconstructFromChunk(chunk, indexInChunk, typeID) {
		const rawData = {}
		const info = Schema.componentInfo[typeID]
		const componentArrays = chunk.componentArrays[typeID]

		// First, gather all the raw, flattened data for the entity from the chunk's SoA arrays.
		for (const propKey of info.propertyKeys) {
			const propArray = componentArrays[propKey]
			if (propArray) {
				rawData[propKey] = propArray[indexInChunk]
			}
		}

		// Now, use the centralized interpreter to reconstruct the high-level object.
		return reconstructWithInterpreter(typeID, rawData)
	}
}

export const componentDataReconstructor = new ComponentDataReconstructor()