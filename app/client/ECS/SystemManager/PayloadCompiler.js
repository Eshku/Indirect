/**
 * Compiles high-level entity data into low-level binary payloads.
 * This is a build-time or setup-time utility, not for use in hot loops.
 * This is a key part of the Zero-Overhead Data Pipeline, designed to eliminate
 * runtime object traversal and deserialization for entity creation.
 *
 * ---
 * ### DEV-NOTE: The "Write" Assembly Authority
 * This service is the authority for the **"Write Path" payload assembly**. Its
 * responsibility is to take a high-level entity definition (e.g., `{ Position: {x:10} }`
 * or a prefab name) and orchestrate its compilation into a final, engine-ready binary
 * `ArrayBuffer` payload. It is a stateful service that uses the stateless
 * `ComponentInterpreter` for data transformation and then uses core managers
 * (`ArchetypeManager`, `PrefabManager`) to assemble the final payload.
 */

const { interpret } = await import('../ComponentManager/ComponentInterpreter.js')
import * as Schema from '../ComponentManager/ComponentSchema.js'

class PayloadCompiler {
	constructor() {
		this.componentManager = null
		this.prefabManager = null
	}

	init(ecs) {
		this.componentManager = ecs.componentManager
		this.entityManager = ecs.entityManager
		this.prefabManager = ecs.prefabManager
	}

	/**
	 * Compiles a single entity definition into a binary payload.
	 * The payload is in a "flattened SoA" format, optimized for single entity creation.
	 * Use with `commands.createEntity()`.
	 * @param {string|object} source - A prefab name or a component data object.
	 * @param {object} [overrides={}] - Component data to override prefab defaults.
	 * @returns {{payload: {archetypeId: number, data: ArrayBuffer}, mutators: object}}
	 */
	compileEntity(source, overrides = {}) {
		if (typeof source === 'string') {
			return this._compilePrefab(source, overrides, this._compileSoA.bind(this))
		} else if (typeof source === 'object' && source !== null) {
			return this._compileFromObject(source, this._compileSoA.bind(this))
		} else {
			throw new TypeError(
				'PayloadCompiler.compileEntity: First argument must be a prefab name (string) or a component data object.'
			)
		}
	}

	/**
	 * Compiles a batch of identical entities into a binary payload.
	 * The payload is in an "AoS" format, optimized for batch creation.
	 * Use with `commands.createEntities()`.
	 * @param {string|object} source - A prefab name or a component data object.
	 * @param {object} [overrides={}] - Component data to override prefab defaults.
	 * @returns {{payload: {archetypeId: number, data: ArrayBuffer}, mutators: object}}
	 */
	compileEntities(source, overrides = {}) {
		if (typeof source === 'string') {
			return this._compilePrefab(source, overrides, this._compileAoS.bind(this))
		} else if (typeof source === 'object' && source !== null) {
			return this._compileFromObject(source, this._compileAoS.bind(this))
		} else {
			throw new TypeError(
				'PayloadCompiler.compileEntities: First argument must be a prefab name (string) or a component data object.'
			)
		}
	}



	/**
	 * Compiles the data for a single component into a binary payload with mutators.
	 * This is the "fast path" for `commands.addComponent()` and `commands.setComponentData()`.
	 * You compile once in `init()` and then use the mutators in the hot loop.
	 * @param {number} typeID The component's type ID.
	 * @param {object} [data={}] The high-level data object to use as a template.
	 * @returns {{payload: {typeID: number, data: ArrayBuffer}, mutators: object}}
	 */
	compileComponent(typeID, data = {}) {
		const info = Schema.componentInfo[typeID]
		if (!info) {
			throw new Error(`PayloadCompiler.compileComponent: Component with typeID ${typeID} not found.`)
		}

		// The "archetype" for a single component is just that component itself.
		const archetypeId = this.entityManager.getArchetype([typeID])

		// Interpret the high-level data into a raw, flattened data object.
		const rawData = interpret(typeID, data)

		// Create the componentDataMap needed by the internal compiler.
		const componentDataMap = new Map([[typeID, rawData]])

		// Use the SoA compiler, as this is for a single component payload.
		const { payload, mutators } = this._compileSoA(archetypeId, componentDataMap)

		return {
			payload: { typeID, data: payload.data },
			mutators,
		}
	}

	compileComponents(typeIDs, data = {}) {
		//! this will be main way of pre-compiling data for single entity.
		//! Could be used for single component addition or multiple
		//! Compile component probably going to be alias for simplicity.
		//!This is going to be Soa based
	}

	compileComponentsForEntities(typeIDs, data = {}) {
		//!AoS - based way to pre-compile single or multiple components
		//! to MULTIPLE entities (query based or some batch commands later on)

		//! Gonna need to adapt command buffer and archetype manager
		//! once done probably can tear apart managers too.
	}

	/**
	 * The internal, low-level workhorse for compiling a payload.
	 * @param {number} archetypeId The target archetype for the entity.
	 * @param {Map<number, object>} componentDataMap A map of componentTypeID to its high-level data object.
	 * @returns {{payload: {archetypeId: number, data: ArrayBuffer}, mutators: object}} A payload object with its mutators.
	 * @private
	 */
	_compileAoS(archetypeId, componentDataMap) {
		const componentTypeIDs = this.entityManager.archetypeComponentTypeIDs[archetypeId]
		if (!componentTypeIDs) {
			throw new Error(`PayloadCompiler: Archetype with ID ${archetypeId} not found.`)
		}

		// --- 1. Calculate total size and component offsets from the Schema ---
		// The component type IDs from the archetype are a Set. Convert to an array and sort
		// to ensure a deterministic layout, identical to how Chunks are created.
		// This logic must perfectly mirror the alignment logic in SchemaCompiler.
		const sortedTypeIDs = [...componentTypeIDs].sort((a, b) => a - b)
		let totalByteSize = 0
		const componentOffsets = new Map()
		for (const typeID of sortedTypeIDs) {
			const info = Schema.componentInfo[typeID]
			// Align the current offset to meet the requirement of the current component.
			const alignment = info.alignment
			if (alignment > 0 && totalByteSize % alignment !== 0) {
				totalByteSize += alignment - (totalByteSize % alignment)
			}
			componentOffsets.set(typeID, totalByteSize)
			totalByteSize += info.byteSize
		}

		// --- 2. Allocate buffer and create DataView ---
		const payloadBuffer = new ArrayBuffer(totalByteSize)
		const payloadView = new DataView(payloadBuffer)

		// --- 3. Write data and create mutators ---
		const mutators = {}
		for (const typeID of sortedTypeIDs) {
			const info = Schema.componentInfo[typeID]
			const componentName = Schema.componentNames[typeID]
			const compiledDefaults = Schema.compiledDefaults[typeID]

			mutators[componentName] = {}

			// We must iterate over the original schema keys to correctly handle complex types
			// that are flattened into multiple properties. NO, we iterate over final keys.
			for (const propKey of info.propertyKeys) {
				// Get the pre-calculated base offset for this component.
				const componentBaseOffset = componentOffsets.get(typeID)
				const initialData = componentDataMap.get(typeID) || {}

				// The data in `initialData` is already fully interpreted and flattened by `createIdMapFromData`.
				// We just need to iterate through the schema's *final* property keys and write the values.
				const propInfo = info.properties[propKey]
				if (!propInfo) continue // Skip properties that don't exist in the final schema (like original array names)

				const value = initialData[propKey] ?? compiledDefaults[propKey]

				const writeOffset = componentBaseOffset + propInfo.offset // Use pre-calculated, aligned offset
				this._writeValue(payloadView, writeOffset, value, propInfo.type)

				// Create a mutator for this property.
				// We create mutators for the original, high-level properties, not the flattened ones.
				const rep = info.representations[propKey]
				if (rep) {
					// This is a high-level property like 'position' or 'tags'
					if (rep.type === 'flat_array') {
						// Use the item's representation to get the correct constructor.
						const itemConstructor = Schema.TYPED_ARRAY_MAP[rep.itemRepresentation.type]
						// Create mutators for the array and its length property
						const arrayStartOffset = componentBaseOffset + info.properties[`${propKey}0`].offset
						mutators[componentName][propKey] = new itemConstructor(payloadBuffer, arrayStartOffset, rep.capacity)
						mutators[componentName][rep.lengthProperty] = new info.properties[rep.lengthProperty].arrayConstructor(
							payloadBuffer,
							componentBaseOffset + info.properties[rep.lengthProperty].offset,
							1
						)
					} else {
						mutators[componentName][propKey] = new propInfo.arrayConstructor(payloadBuffer, writeOffset, 1)
					}
				}
			} // end for(originalPropKey)
		} // end for(typeID)

		const payload = {
			archetypeId,
			data: payloadBuffer,
		}

		// The payload itself is mutable via the mutators, but the structure of the
		// returned object is frozen to prevent accidental modification.
		return Object.freeze({ payload, mutators: Object.freeze(mutators) })
	}

	/**
	 * The internal, low-level workhorse for compiling a payload into a "flattened" SoA binary format.
	 * This format is a single ArrayBuffer containing the data for one entity, with components laid out sequentially.
	 * @param {number} archetypeId The target archetype for the entity.
	 * @param {Map<number, object>} componentDataMap A map of componentTypeID to its high-level data object.
	 * @returns {{payload: {archetypeId: number, data: ArrayBuffer}, mutators: object}} A payload object with its mutators.
	 * @private
	 */
	_compileSoA(archetypeId, componentDataMap) {
		const componentTypeIDs = this.entityManager.archetypeComponentTypeIDs[archetypeId]
		if (!componentTypeIDs) {
			throw new Error(`PayloadCompiler: Archetype with ID ${archetypeId} not found.`)
		}

		const sortedTypeIDs = [...componentTypeIDs].sort((a, b) => a - b)
		let totalByteSize = 0
		const componentOffsets = new Map()
		for (const typeID of sortedTypeIDs) {
			const info = Schema.componentInfo[typeID]
			const alignment = info.alignment
			if (alignment > 0 && totalByteSize % alignment !== 0) {
				totalByteSize += alignment - (totalByteSize % alignment)
			}
			componentOffsets.set(typeID, totalByteSize)
			totalByteSize += info.byteSize
		}

		const payloadBuffer = new ArrayBuffer(totalByteSize)
		const payloadView = new DataView(payloadBuffer)
		const mutators = {}

		for (const typeID of sortedTypeIDs) {
			const info = Schema.componentInfo[typeID]
			const componentName = Schema.componentNames[typeID]
			const compiledDefaults = Schema.compiledDefaults[typeID]
			const initialData = componentDataMap.get(typeID) || {}

			mutators[componentName] = {}
			// Iterate over original schema keys to correctly create mutators for high-level properties like flat_arrays
			for (const propKey of info.originalSchemaKeys) {
				const propInfo = info.properties[propKey]
				const rep = info.representations[propKey]
				if (!rep) continue // Skip implicit properties like 'flat_array_count'

				if (rep.type === 'flat_array') {
					const itemConstructor = Schema.TYPED_ARRAY_MAP[rep.itemRepresentation.type]
					const arrayStartOffset = componentOffsets.get(typeID) + info.properties[`${propKey}0`].offset
					mutators[componentName][propKey] = new itemConstructor(payloadBuffer, arrayStartOffset, rep.capacity)
					mutators[componentName][rep.lengthProperty] = new info.properties[rep.lengthProperty].arrayConstructor(
						payloadBuffer,
						componentOffsets.get(typeID) + info.properties[rep.lengthProperty].offset,
						1
					)
				} else if (propInfo) {
					const writeOffset = componentOffsets.get(typeID) + propInfo.offset
					mutators[componentName][propKey] = new propInfo.arrayConstructor(payloadBuffer, writeOffset, 1)
				}
			}
			for (const propKey of info.propertyKeys) {
				// Now iterate all final properties to write data
				const propInfo = info.properties[propKey]
				if (!propInfo) continue

				const value = initialData[propKey] ?? compiledDefaults[propKey]
				const writeOffset = componentOffsets.get(typeID) + propInfo.offset
				this._writeValue(payloadView, writeOffset, value, propInfo.type)
			}
		}

		const payload = {
			archetypeId,
			data: payloadBuffer,
		}

		return Object.freeze({ payload, mutators: Object.freeze(mutators) })
	}

	/**
	 * Internal helper to compile from a component object.
	 * @param {object} componentDataObject
	 * @returns {ReturnType<this['_compile']>}
	 * @private
	 */
	_compileFromObject(componentDataObject, compileFn) {
		// This is the "Interpreter" step. It uses ComponentInterpreter to process
		// high-level data into a map of typeID -> raw numeric data.
		const componentDataMap = this._createIdMapFromData(componentDataObject)

		// Determine the archetype from the provided components.
		const archetypeId = this.entityManager.getArchetype(componentDataMap.keys())
		return compileFn(archetypeId, componentDataMap)
	}

	/**
	 * Internal helper to compile from a prefab with overrides.
	 * @param {string} prefabName
	 * @param {object} overrides
	 * @returns {ReturnType<this['_compile']>}
	 * @private
	 */
	_compilePrefab(prefabName, overrides = {}, compileFn) {
		const prefabData = this.prefabManager.getPrefabData(prefabName)
		if (!prefabData) {
			throw new Error(`PayloadCompiler: Prefab '${prefabName}' not found.`)
		}

		// Merge prefab data with overrides.
		const finalComponentData = { ...prefabData.components }
		for (const compName in overrides) {
			finalComponentData[compName] = { ...(finalComponentData[compName] || {}), ...overrides[compName] }
		}

		// Run the merged data through the interpreter.
		// Pass the final component data object to the object compiler, which will
		// handle creating the ID map and determining the archetype.
		return this._compileFromObject(finalComponentData, compileFn)
	}

	/**
	 * @private
	 * Helper to write a value to a DataView with the correct type.
	 */
	_writeValue(view, offset, value, type) {
		const constructor = Schema.TYPED_ARRAY_MAP[type]
		if (!constructor) {
			throw new Error(`PayloadCompiler: Unknown property type for writing: ${type}`)
		}

		switch (constructor.BYTES_PER_ELEMENT) {
			case 8:
				if (type.startsWith('f')) view.setFloat64(offset, value, true)
				else {
					// Value might already be a bigint from the interpreter.
					const bigIntValue = typeof value === 'bigint' ? value : BigInt(value)
					if (type.startsWith('i')) view.setBigInt64(offset, bigIntValue, true)
					else view.setBigUint64(offset, bigIntValue, true)
				}
				break
			case 4:
				if (type.startsWith('f')) {
					view.setFloat32(offset, value, true)
				} else {
					// Allow bigint to be written to 32-bit fields, but it will truncate.
					// This is expected for entity IDs where we only need the index part sometimes.
					const numValue = typeof value === 'bigint' ? Number(value & 0xffffffffn) : value
					if (type.startsWith('i')) view.setInt32(offset, numValue, true)
					else view.setUint32(offset, numValue, true)
				}
				break
			case 2:
				if (type.startsWith('i')) view.setInt16(offset, value, true)
				else view.setUint16(offset, value, true)
				break
			case 1:
				if (type.startsWith('i')) view.setInt8(offset, value)
				else view.setUint8(offset, value)
				break
			default:
				throw new Error(`PayloadCompiler: Unsupported byte size for type: ${type}`)
		}
	}

	// --- Internal Orchestration Logic ---

	_createIdMapFromData(componentsInput, existingPrefabId = 0) {
		const perEntityDataMap = new Map()
		const sharedDataPayload = {}
		let prefabId = existingPrefabId

		if (!componentsInput) return perEntityDataMap

		for (const componentName in componentsInput) {
			if (!Object.prototype.hasOwnProperty.call(componentsInput, componentName)) continue

			const typeID = Schema.componentNameToTypeID.get(componentName.toLowerCase())
			if (typeID === undefined) continue

			const info = Schema.componentInfo[typeID]
			if (!info) continue

			let rawData = interpret(typeID, componentsInput[componentName])

			const defaults = Schema.compiledDefaults[typeID]
			rawData = { ...defaults, ...rawData }

			const perEntityPart = {}
			const sharedPart = {}
			let hasSharedPart = false

			for (const propName in rawData) {
				if (info.representations[propName]?.shared) {
					sharedPart[propName] = rawData[propName]
					hasSharedPart = true
				} else {
					perEntityPart[propName] = rawData[propName]
				}
			}

			if (hasSharedPart) sharedDataPayload[typeID] = sharedPart
			perEntityDataMap.set(typeID, perEntityPart)
		}

		const prefabComponentTypeId = Schema.componentNameToTypeID.get('prefab')
		if (prefabId === 0) {
			const prefabSharedData = sharedDataPayload[prefabComponentTypeId]
			if (prefabSharedData?.id !== undefined) {
				const idOrName = prefabSharedData.id
				// The ID could be a string name from a prefab `extends` property.
				// We must resolve it to a numeric ID.
				prefabId =
					typeof idOrName === 'string' ? this.prefabManager.getPrefabId(idOrName) : Number(idOrName & 0xffffffffn)
			}
		}

		if (prefabId > 0 && Object.keys(sharedDataPayload).length > 0) {
			const sharedGroupId =
				existingPrefabId > 0
					? this.componentManager.propertyGroupManager.addSharedDataToGroup(prefabId, sharedDataPayload)
					: this.componentManager.propertyGroupManager.getOrCreateSharedGroup(prefabId, sharedDataPayload)

			for (const typeIDStr in sharedDataPayload) {
				const componentTypeId = Number(typeIDStr)
				if (Schema.componentInfo[componentTypeId].sharedProperties.length > 0) {
					perEntityDataMap.get(componentTypeId).sharedGroupId = sharedGroupId
				}
			}
		}
		return perEntityDataMap
	}
}

export const payloadCompiler = new PayloadCompiler()
