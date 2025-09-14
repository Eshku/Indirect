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

class ComponentDataReconstructor {
	constructor() {
		// This service is stateless.
		this.archetypeManager = null
	}

	init({ archetypeManager }) {
		this.archetypeManager = archetypeManager
	}

	/**
	 * Reconstructs a component's data for a given entity.
	 * This is the main entry point for the read path.
	 * @param {number} entityId The ID of the entity to read from.
	 * @param {number} typeID The component's type ID.
	 * @returns {object | undefined} The reconstructed component data, or undefined if not found.
	 */
	reconstruct(entityId, typeID) {
		const archetypeId = this.archetypeManager.entityManager.getArchetypeForEntity(entityId)
		if (archetypeId === undefined || !this.archetypeManager.hasComponentType(archetypeId, typeID)) {
			return undefined
		}

		const location = this.archetypeManager.archetypeEntityMaps[archetypeId]?.get(entityId)
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
		if (!rawSharedData) return {}

		const reconstructedData = {}
		const info = Schema.componentInfo[typeID]

		for (const propName in rawSharedData) {
			const rep = info.representations[propName]
			const rawValue = rawSharedData[propName]

			if (!rep) {
				reconstructedData[propName] = rawValue
				continue
			}

			switch (rep.type) {
				case 'enum':
					reconstructedData[propName] = rep.valueMap[rawValue]
					break
				case 'string':
					reconstructedData[propName] = stringInterningTable.get(rawValue)
					break
				default: // Primitives
					reconstructedData[propName] = rawValue
					break
			}
		}
		return reconstructedData
	}

	_reconstructFromChunk(chunk, indexInChunk, typeID) {
		const componentData = {}
		const info = Schema.componentInfo[typeID]
		const componentArrays = chunk.componentArrays[typeID]

		for (const propName in info.representations) {
			const rep = info.representations[propName]
			if (!rep || rep.shared) continue

			if (propName === 'sharedGroupId') {
				if (componentArrays[propName]) componentData[propName] = componentArrays[propName][indexInChunk]
				continue
			}

			switch (rep.type) {
				case 'rpn':
					break // Composite type, handled by its flattened properties.
				case 'flat_array': {
					const sourceArray = []
					const len = componentArrays[rep.lengthProperty][indexInChunk]
					const itemRep = rep.itemRepresentation
					for (let i = 0; i < len; i++) {
						const rawValue = componentArrays[`${propName}${i}`][indexInChunk]
						if (itemRep.originalType === 'string') sourceArray.push(stringInterningTable.get(rawValue))
						else if (itemRep.originalType === 'enum') sourceArray.push(itemRep.valueMap[rawValue])
						else sourceArray.push(rawValue)
					}
					componentData[propName] = sourceArray
					break
				}
				case 'enum':
					componentData[propName] = rep.valueMap[componentArrays[propName][indexInChunk]]
					break
				case 'bitmask':
					const rawValue = componentArrays[propName][indexInChunk]
					componentData[propName] = Object.keys(rep.flagMap).filter(flag => (rawValue & rep.flagMap[flag]) !== 0)
					break
				case 'string':
					componentData[propName] = stringInterningTable.get(componentArrays[propName][indexInChunk])
					break
				default: // Primitives
					if (componentArrays?.[propName]) componentData[propName] = componentArrays[propName][indexInChunk]
					break
			}
		}
		return componentData
	}
}

export const componentDataReconstructor = new ComponentDataReconstructor()