/**
 * Compiles high-level entity data into low-level binary payloads.
 * This is a build-time or setup-time utility, not for use in hot loops.
 * This is a key part of the Zero-Overhead Data Pipeline, designed to eliminate runtime object traversal and
 * deserialization for entity creation.
 *
 * ---
 * ### DEV-NOTE: The "Write" Path Assembler
 * This service is the authority for the **"Write" Path payload assembly**. Its responsibility is to take a high-level
 * entity definition (e.g., `{ Position: {x:10} }` or a prefab name) and assemble it into a final, engine-ready binary
 * `ArrayBuffer` payload.
 *
 * It operates as a client of several other services:
 * 1.  **`ComponentInterpreter`**: To transform high-level data (like strings) into raw numeric values.
 * 2.  **`SchemaCompiler`**: To get the `componentInfo` blueprint, which contains the memory layout and pre-compiled `mutatorFactories`.
 * 3.  **`EntityManager` / `PrefabManager`**: To resolve archetypes and prefab data.
 *
 * The `PayloadCompiler` itself is a "dumb" assembler; it allocates a buffer and executes the mutator factories
 * provided by the `SchemaCompiler` to create the final payload and its mutators.
 */

const { interpret } = await import('../ComponentManager/ComponentInterpreter.js')
import * as Schema from '../ComponentManager/ComponentSchema.js'

class PayloadCompiler {
	constructor() {
		this.componentManager = null
		this.prefabManager = null
		this.sharedDataManager = null
	}

	init(ecs) {
		this.componentManager = ecs.componentManager
		this.entityManager = ecs.entityManager
		this.prefabManager = ecs.prefabManager
		this.sharedDataManager = ecs.sharedDataManager
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
			return this._compilePrefab(source, overrides, this._compile.bind(this))
		} else if (typeof source === 'object' && source !== null) {
			return this._compileFromObject(source, this._compile.bind(this))
		} else {
			throw new TypeError(
				'PayloadCompiler.compileEntity: First argument must be a prefab name (string) or a component data object.',
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
			return this._compilePrefab(source, overrides, this._compile.bind(this))
		} else if (typeof source === 'object' && source !== null) {
			return this._compileFromObject(source, this._compile.bind(this))
		} else {
			throw new TypeError(
				'PayloadCompiler.compileEntities: First argument must be a prefab name (string) or a component data object.',
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
		const { payload, mutators } = this._compile(archetypeId, componentDataMap)

		return {
			payload: { typeID, data: payload.data },
			mutators,
		}
	}

	/**
	 * [FUTURE] Pre-compiles a payload for one or more components for a single entity.
	 * This will be the primary way to get a payload for `commands.addComponent` or `commands.setComponent`.
	 * @param {number[]} typeIDs - An array of component type IDs.
	 * @param {object} [data={}] - A data object where keys are component names.
	 * @returns {{payload: {archetypeId: number, data: ArrayBuffer}, mutators: object}}
	 */
	compileComponents(typeIDs, data = {}) {
		// This will be the main way of pre-compiling data for a single entity's components.
		// It will be SoA-based for efficient single-entity structural changes.
		// `compileComponent` will become an alias for this with a single typeID.
		throw new Error('compileComponents is not yet implemented.')
	}

	/**
	 * [FUTURE] Pre-compiles a payload for one or more components for a BATCH of entities.
	 * This will be used for efficient, query-based batch modifications.
	 * @param {number[]} typeIDs - An array of component type IDs.
	 * @param {object} [data={}] - A data object where keys are component names.
	 * @returns {{payload: {archetypeId: number, data: ArrayBuffer}, mutators: object}}
	 */
	compileComponentsForEntities(typeIDs, data = {}) {
		// This will be AoS-based for efficient batch creation/modification of many entities.
		throw new Error('compileComponentsForEntities is not yet implemented.')
	}

	/**
	 * The internal, low-level workhorse for compiling a payload into a "flattened struct" binary format.
	 * This format is a single ArrayBuffer containing the data for one entity, with components laid out sequentially.
	 * @param {number} archetypeId The target archetype for the entity.
	 * @param {Map<number, object>} componentDataMap A map of componentTypeID to its high-level data object.
	 * @returns {{payload: {archetypeId: number, data: ArrayBuffer}, mutators: object}} A payload object with its mutators.
	 * @private
	 */
	_compile(archetypeId, componentDataMap) {
		const sortedTypeIDs = this.entityManager.getComponentTypeIDsForArchetype(archetypeId)
		if (!sortedTypeIDs) {
			throw new Error(`PayloadCompiler: Archetype with ID ${archetypeId} not found.`)
		}

		let totalByteSize = 0 // The rest of the logic remains the same.
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

			// Execute the pre-compiled mutator factory functions from the schema.
			const componentBaseOffset = componentOffsets.get(typeID)
			for (const factory of info.mutatorFactories) {
				factory(mutators[componentName], payloadBuffer, componentBaseOffset, info)
			}
			for (const propKey of info.propertyKeys) { // Now iterate all final properties to write data
				// Now iterate all final properties to write data
				const propInfo = info.properties[propKey]
				if (!propInfo) continue

				const value = initialData[propKey] ?? compiledDefaults[propKey]
				const componentBaseOffset = componentOffsets.get(typeID)
				let writeOffset = componentBaseOffset + propInfo.offset
				const alignment = propInfo.alignment
				if (alignment > 0 && writeOffset % alignment !== 0) {
					writeOffset += alignment - (writeOffset % alignment)
				}
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

	_createIdMapFromData(componentsInput) {
		const perEntityDataMap = new Map()
		const prototypeData = {}

		if (!componentsInput) return perEntityDataMap

		for (const componentName in componentsInput) {
			if (!Object.prototype.hasOwnProperty.call(componentsInput, componentName)) continue

			const typeId = Schema.componentNameToTypeID.get(componentName.toLowerCase())
			if (typeId === undefined) continue

			const info = Schema.componentInfo[typeId]
			if (!info) continue

			let rawData = interpret(typeId, componentsInput[componentName])

			const defaults = Schema.compiledDefaults[typeId]
			rawData = { ...defaults, ...rawData }

			const perEntityPart = {}
			const sharedPart = {}
			let hasSharedPart = false

			// Separate shared and per-entity properties
			for (const propKey in rawData) {
				if (info.sharedProperties.includes(propKey)) {
					sharedPart[propKey] = rawData[propKey]
					hasSharedPart = true
				} else {
					perEntityPart[propKey] = rawData[propKey]
				}
			}

			if (hasSharedPart) {
				const sharedDataIndex = this.sharedDataManager.getOrCreateSharedDataIndex(typeId, sharedPart)
				prototypeData[typeId] = sharedDataIndex
			}
			perEntityDataMap.set(typeId, perEntityPart)
		}

		// Get a single prototypeId for the entire collection of shared data.
		const prototypeId = this.sharedDataManager.getOrCreatePrototype(prototypeData)

		// Inject the prototypeId into every component that has shared properties.
		for (const typeIdStr in prototypeData) {
			const componentTypeId = Number(typeIdStr)
			perEntityDataMap.get(componentTypeId).prototypeId = prototypeId
		}

		return perEntityDataMap
	}
}

export const payloadCompiler = new PayloadCompiler()
