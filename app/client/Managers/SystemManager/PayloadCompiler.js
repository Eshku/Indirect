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

const { interpret, resolveComponentData } = await import(`@managers/ComponentManager/ComponentInterpreter.js`)

const Schema = await import(`@managers/ComponentManager/ComponentSchema.js`)

class PayloadCompiler {
	init(engine) {
		this.entityManager = engine.entityManager
		this.prefabManager = engine.prefabManager
		this.sharedDataManager = engine.sharedDataManager
		this.componentManager = engine.componentManager

		this.prefabComponentId = Schema.componentNameToTypeID.get('prefab')
	}

	/**
	 * The universal compiler method. It creates a binary payload from a high-level definition.
	 * Its behavior is overloaded based on the type of the `source` argument.
	 *
	 * - **`compile(prefabName, overrides)`**: Compiles an entity from a prefab with optional overrides.
	 * - **`compile(componentObject)`**: Compiles an entity from a component data object.
	 * - **`compile(componentTypeID, data)`**: Compiles a single component's data.
	 *
	 * @param {string|object|number} source - The source to compile from.
	 * @param {object} [dataOrOverrides={}] - Overrides for a prefab or data for a single component.
	 * @returns {{payload: object, mutators: object}} The compiled payload and its mutators.
	 */
	compile(source, dataOrOverrides = {}) {
		// Case 1: Prefab name (string)
		if (typeof source === 'string') {
			return this._compilePrefab(source, dataOrOverrides, this._compile.bind(this))
		}
		// Case 2: Component data object for an entity
		else if (typeof source === 'object' && source !== null) {
			return this._compileFromObject(source, this._compile.bind(this))
		}
		// Case 3: Single component type ID (number)
		else if (typeof source === 'number') {
			const typeID = source
			const data = dataOrOverrides

			const info = Schema.componentInfo[typeID]
			if (!info) {
				throw new Error(`PayloadCompiler.compile: Component with typeID ${typeID} not found.`)
			}

			const archetypeId = this.entityManager.getArchetype([typeID])
			const resolvedData = resolveComponentData(typeID, data)
			const rawData = interpret(typeID, resolvedData)
			const componentDataMap = new Map([[typeID, rawData]])
			const { payload, mutators } = this._compile(archetypeId, componentDataMap)

			return {
				payload: {
					typeID,
					data: payload.data,
					trackableComponentIds: payload.trackableComponentIds,
				},
				mutators,
			}
		}
		// Error case
		else {
			throw new TypeError(
				'PayloadCompiler.compile: First argument must be a prefab name (string), a component data object, or a component type ID (number).',
			)
		}
	}

	/**
	 * Compiles a special-purpose payload containing the default values for a set of components.
	 * This is used for efficiently resetting pooled entities.
	 *
	 * @param {string|object} source - A prefab name or a component object defining the set of components to get defaults for.
	 * @param {object} [overrides={}] - A component data object specifying values to use instead of the schema defaults.
	 * @param {string[]} [ignores=[]] - An array of component names to exclude from the defaults payload.
	 * @returns {{payload: object, mutators: object}} The compiled payload containing default values.
	 */
	compileDefaults(source, overrides = {}, ignores = []) {
		let sourceComponentData = {}
		if (typeof source === 'string') {
			// Prefab name
			const prefabData = this.prefabManager.getPrefabData(source)
			if (!prefabData) {
				throw new Error(`PayloadCompiler.compileDefaults: Prefab '${source}' not found.`)
			}
			// A prefab file has a top-level 'components' key. We need to use the inner object.
			sourceComponentData = prefabData.components || prefabData
		} else if (typeof source === 'object' && source !== null) {
			// Component object
			sourceComponentData = source
		} else {
			throw new TypeError(
				'PayloadCompiler.compileDefaults: First argument must be a prefab name or a component data object.',
			)
		}

		const componentNames = Object.keys(sourceComponentData)
		const allTypeIDs = []
		for (const name of componentNames) {
			const typeID = Schema.componentNameToTypeID.get(name.toLowerCase())
			if (typeID !== undefined) {
				allTypeIDs.push(typeID)
			} else {
				// A prefab might contain components not known to this client (e.g. server-only components).
				// This is a valid scenario, so we warn instead of throwing an error.
				console.warn(`PayloadCompiler.compileDefaults: Component name "${name}" not found in schema. It will be ignored.`)
			}
		}

		const ignoresSet = new Set(ignores)
		const typeIDsToCompile = allTypeIDs.filter(id => !ignoresSet.has(id))
		const componentDataMap = new Map()
		const interpretedOverrides = this._createIdMapFromData(overrides)

		for (const typeID of typeIDsToCompile) {
			const schemaDefaults = Schema.compiledDefaults[typeID]
			const overrideData = interpretedOverrides.get(typeID) || {}
			const finalData = { ...schemaDefaults, ...overrideData }
			componentDataMap.set(typeID, finalData)
		}

		const archetypeId = this.entityManager.getArchetype(componentDataMap.keys())
		return this._compile(archetypeId, componentDataMap)
	}

	/**
	 * [PLANNED] Compiles component data for a BATCH of entities, each with varying data for the same component type.
	 * This is intended for a future `commands.setComponent(payload)` command.
	 *
	 * This method produces a **Structure-of-Arrays (SoA)** payload, which is fundamentally
	 * different from the AoS payload produced by `compile`. SoA is highly efficient
	 * for batch-updating a single component across many entities, as it mirrors the engine's
	 * internal chunk storage format.
	 *
	 * @example
	 * // const positionPayload = compileComponentsForEntities({ Position: [{x:1}, {x:2}, ...] });
	 * @param {object} componentsObject - An object where keys are component names and values are arrays of data for each entity.
	 * @returns {{payload: {archetypeId: number, data: ArrayBuffer}, mutators: object}}
	 */
	compileComponentsForEntities(componentsObject) {
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

		const trackableComponentIds = []

		let totalByteSize = 0 // The rest of the logic remains the same.
		const componentOffsets = new Map()
		for (const typeID of sortedTypeIDs) {
			const info = Schema.componentInfo[typeID]
			if (info.isTrackable) {
				trackableComponentIds.push(typeID)
			}
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
			for (const propKey of info.propertyKeys) {
				// Now iterate all final properties to write data
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
			trackableComponentIds,
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
		const finalComponentData = { ...prefabData }
		for (const compName in overrides) {
			const overrideData = overrides[compName]
			const prefabCompData = finalComponentData[compName]

			// This logic correctly handles both partial object overrides and primitive/shorthand overrides.
			if (
				typeof overrideData === 'object' &&
				overrideData !== null &&
				!Array.isArray(overrideData) &&
				typeof prefabCompData === 'object' &&
				prefabCompData !== null &&
				!Array.isArray(prefabCompData)
			) {
				finalComponentData[compName] = { ...prefabCompData, ...overrideData }
			} else {
				finalComponentData[compName] = overrideData
			}
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

			// Step 1: Resolve shorthands and apply high-level defaults.
			const resolvedData = resolveComponentData(typeId, componentsInput[componentName])
			// Step 2: Interpret the fully-specified high-level data into low-level raw data.
			const rawData = interpret(typeId, resolvedData)

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
