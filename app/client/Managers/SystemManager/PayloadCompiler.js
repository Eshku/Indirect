/**
 * Compiles high-level entity data into low-level binary payloads.
 * This is a setup-time utility, designed to be called once in a system's `init()` method
 * to create reusable templates. It is a key part of the Zero-Overhead Data Pipeline.
 *
 * ---
 * ### DEV-NOTE: The "Live" SoA Payload Factory
 * This service is the authority for creating "live" Structure-of-Arrays (SoA) payloads. Its responsibility is to take a
 * high-level entity definition (e.g., `{ position: {x:10} }` or a prefab name) and compile it into a mutable payload
 * object that can be efficiently manipulated and serialized by the command buffer.
 *
 * The term "live" means the returned payload is not a static snapshot. Its `buffers` property contains mutable `TypedArray`
 * views into the underlying binary data. You can compile a payload once and then write to its buffers at runtime before
 * passing it to the command buffer, making it a powerful tool for creating varied entities without re-compiling.
 *
 * ---
 * ### USAGE PATTERNS
 *
 * #### 1. Basic Compilation (in `init()`)
 *
 * ```javascript
 * // Compile from a component object
 * this.myObjectPayload = this.compile({ position: { x: 10, y: 20 } });
 *
 * // Compile from a prefab name
 * this.myPrefabPayload = this.compile('my_prefab');
 * ```
 *
 * #### 2. Compiling with Overrides (in `init()`)
 *
 * ```javascript
 * // Compile a prefab, but override the position
 * this.modifiedPrefabPayload = this.compile('my_prefab', {
 *   overrides: {
 *     position: { x: 99, y: 99 }
 *   }
 * });
 *
 * // A powerful trick: override with an empty object to reset a component
 * // to its schema defaults, ignoring the prefab's values.
 * this.resetPrefabPayload = this.compile('my_prefab', {
 *   overrides: {
 *     position: {} // Position will be {x: 0, y: 0} from schema, not prefab
 *   }
 * });
 * ```
 *
 * #### 3. Runtime Mutation for Varied Entities (in `update()`)
 *
 * ```javascript
 * // In init(), compile a payload with a capacity greater than 1.
 * this.variedPayload = this.compile({ position: {} }, { count: 10 });
 *
 * // In update(), you can write unique data to the payload's buffers before creating entities.
 * this.variedPayload.buffers.position.x[0] = 100;
 * this.variedPayload.buffers.position.y[0] = 100;
 * this.variedPayload.buffers.position.x[1] = 200;
 * this.variedPayload.buffers.position.y[1] = 200;
 *
 * // Instantiate only the entities you wrote data for.
 * this.instantiate(this.variedPayload, 2);
 * ```
 */

const { interpret, resolveComponentData, reconstruct } = await import(
	`@managers/ComponentManager/ComponentInterpreter.js`
)

const Schema = await import(`@managers/ComponentManager/ComponentSchema.js`)
const { MAX_COMPONENTS } = await import(`@managers/ComponentManager/ComponentSchema.js`)
const { entityStore } = await import(`@managers/EntityManager/EntityManager.js`)

class PayloadCompiler {
	init(engine) {
		this.entityManager = engine.entityManager
		this.prefabManager = engine.prefabManager
		this.sharedDataManager = engine.sharedDataManager
		this.componentManager = engine.componentManager

		this.componentTypesScratch = new Uint16Array(MAX_COMPONENTS)
		this.prefabComponentId = Schema.componentNameToTypeID.get('prefab')
	}

	/**
	 * The universal compiler method. It creates a "live" SoA payload from a high-level definition.
	 * @param {string|object|number} source - The source: a prefab name (string), a component object, or a single component typeID.
	 * @param {object} [options={}] - Optional configuration.
	 * @param {object} [options.overrides={}] - Overrides for prefab-based compilation.
	 * @param {Array<number>|number} [options.excludes=[]] - Component typeIDs to exclude.
	 * @param {number} [options.count=1] - The number of entities to allocate space for in the SoA payload.
	 * @returns {object} The compiled, live SoA payload.
	 */
	compile(source, options = {}) {
		const { overrides = {}, count = 1 } = options
		let { excludes = [] } = options
		if (Number.isInteger(excludes)) {
			excludes = [excludes]
		}

		// --- 1. Source Resolution ---
		// This step resolves the `source` argument into a base `componentDataObject`.
		let componentDataObject
		if (typeof source === 'string') {
			const prefabData = this.prefabManager.getPrefabData(source)
			if (!prefabData) {
				throw new Error(`PayloadCompiler: Prefab '${source}' not found.`)
			}
			componentDataObject = { ...prefabData } // Create a mutable copy
		} else if (typeof source === 'object' && source !== null) {
			componentDataObject = source
		} else {
			throw new TypeError('PayloadCompiler.compile: First argument must be a prefab name or a component object.')
		}

		// --- 2. Override Application ---
		// If the source was a prefab, apply the `options.overrides`.
		if (typeof source === 'string' && Object.keys(overrides).length > 0) {
			const nameMap = Object.keys(componentDataObject).reduce((map, key) => {
				map[key.toLowerCase()] = key
				return map
			}, {})

			for (const compName in overrides) {
				if (Object.prototype.hasOwnProperty.call(overrides, compName)) {
					const originalCaseName = nameMap[compName.toLowerCase()] || compName
					const overrideData = overrides[compName]
					const prefabCompData = componentDataObject[originalCaseName]

					// The "empty object" override trick to reset to schema defaults.
					if (typeof overrideData === 'object' && overrideData !== null && Object.keys(overrideData).length === 0) {
						componentDataObject[originalCaseName] = {}
					} else if (
						typeof overrideData === 'object' &&
						overrideData !== null &&
						typeof prefabCompData === 'object' &&
						prefabCompData !== null
					) {
						// Merge override data with prefab data.
						componentDataObject[originalCaseName] = { ...prefabCompData, ...overrideData }
					} else {
						// Replace the value entirely (e.g., for shorthand overrides).
						componentDataObject[originalCaseName] = overrideData
					}
				}
			}
		}

		// --- 3. Exclusion Application ---
		// Filter out components specified in `options.excludes`.
		if (excludes.length > 0) {
			const finalData = {}
			const excludeIdSet = new Set(excludes)
			for (const compName in componentDataObject) {
				if (Object.prototype.hasOwnProperty.call(componentDataObject, compName)) {
					const typeId = Schema.componentNameToTypeID.get(compName.toLowerCase())
					if (typeId !== undefined && !excludeIdSet.has(typeId)) {
						finalData[compName] = componentDataObject[compName]
					}
				}
			}
			componentDataObject = finalData
		}

		// --- 4. Archetype & Layout Discovery ---
		const componentDataMap = this._createIdMapFromData(componentDataObject)
		const archetypeId = this.entityManager.getArchetype(componentDataMap.keys())
		const componentCount = this.entityManager.getComponentTypeIDsForArchetype(archetypeId, this.componentTypesScratch)

		// --- DEBUG LOG ---

		// Make a copy of the component IDs. This makes the payload self-contained and ensures
		// that the `serialize` closure captures a stable list, unaffected by subsequent
		// calls to `compile()` that would overwrite the shared `componentTypesScratch` buffer.
		const componentTypeIDs = Array.from(this.componentTypesScratch.subarray(0, componentCount))

		// --- 5. Payload Allocation ---
		const layout = []
		let totalDataSize = 0
		for (const typeId of componentTypeIDs) {
			const info = Schema.componentInfo[typeId]
			const componentName = Schema.componentNames[typeId]
			for (const propKey of info.propertyKeys) {
				const propInfo = info.properties[propKey]


				const bytesPerElement = propInfo.arrayConstructor.BYTES_PER_ELEMENT

				// Align the current offset to the requirement of this property.
				const alignment = bytesPerElement
				if (alignment > 0 && totalDataSize % alignment !== 0) {
					totalDataSize += alignment - (totalDataSize % alignment)
				}
				const propOffset = totalDataSize
				const propSize = count * bytesPerElement

				layout.push({
					typeId,
					componentName,
					propKey,
					propInfo,
					bytesPerElement,
					size: propSize,
					offset: propOffset, // Use the aligned offset
				})
				totalDataSize += propSize
			}
		}

		// The single, pre-packed buffer for all component data.
		const singleBuffer = new ArrayBuffer(totalDataSize)

		// --- 6. View Creation ---
		const buffers = {}
		for (const item of layout) {
			const { componentName, propKey, propInfo, offset } = item
			if (!buffers[componentName]) {
				buffers[componentName] = {}
			}
			const constructor = propInfo.arrayConstructor
			buffers[componentName][propKey] = new constructor(singleBuffer, offset, count)
		}

		// --- 6. Data Population ---
		for (const typeId of componentTypeIDs) {
			const info = Schema.componentInfo[typeId]
			const componentName = Schema.componentNames[typeId]
			const compiledDefaults = Schema.compiledDefaults[typeId]
			const initialData = componentDataMap.get(typeId) || {}

			for (const propKey of info.propertyKeys) {
				if (!buffers[componentName] || !buffers[componentName][propKey]) continue
				const value = initialData[propKey] ?? compiledDefaults[propKey]
				const buffer = buffers[componentName][propKey]
				if (buffer instanceof BigInt64Array || buffer instanceof BigUint64Array) {
					buffer.fill(BigInt(value))
				} else {
					buffer.fill(value)
				}
			}
		}

		// --- 7. Serialization Closure & Final Object ---
		const livePayload = {
			archetypeId,
			capacity: count,
			layout,
			buffers, // mutable
			// componentTypeId is only attached for single-component payloads,
			// which is useful for commands like `addComponent`.
			...(componentTypeIDs.length === 1 && {
				componentTypeId: componentTypeIDs[0],
			}),
		}

		return livePayload
	}

	_createIdMapFromData(componentsInput) {
		const perEntityDataMap = new Map()
		const prototypeData = {}

		if (!componentsInput) return perEntityDataMap

		for (const componentName in componentsInput) {
			if (!Object.prototype.hasOwnProperty.call(componentsInput, componentName)) continue

			const typeId = Schema.componentNameToTypeID.get(componentName.toLowerCase())
			if (typeId === undefined) {
				// This is a critical error. Compiling with a component that doesn't exist in the schema
				// leads to silent failures and difficult-to-debug issues.
				throw new Error(`PayloadCompiler: Attempted to compile with an unknown component name: "${componentName}".`)
			}

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
