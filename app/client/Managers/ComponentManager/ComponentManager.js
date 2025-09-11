/**
 * Manages component registration, schema parsing, and low-level component manipulation.
 *
 * ---
 *
 * ### Architectural Philosophy: A Unified Data Model
 *
 * This manager is central to the engine's data-oriented design. The core principle is that
 * **all** component data is stored in a cache-friendly format.
 *
 * #### Component Schemas (Struct-of-Arrays, SoA)
 *
 * All components are defined by a schema object that maps property names to data types
 * (e.g., `{ x: { type: 'f64' }, y: { type: 'f64' } }`).
 *
 *   performance and architectural simplicity.
 *
 * - **Storage**: The `Archetype` stores component data in `TypedArray`s, one for each property.
 *   This is cache-friendly for systems that iterate over specific properties of many entities.
 * - **Unified Model**: There is no distinction between "hot" and "cold" components. All data follows
 *   this optimized path, ensuring predictable high performance and architectural simplicity.
 * - **Complex Data via Managed References**: For data that doesn't fit in a `TypedArray` (like a `Map` or a
 *   `PIXI.Sprite`), the component schema defines a numeric reference (a "handle" or "Ref", e.g., `u32`).
 *   The actual complex object is stored and managed by a specialized manager (e.g., `AssetManager`),
 *   and the component only holds the lightweight reference.
 *
 * #### Tag Components
 *
 * A tag is a component with an empty schema (`{}`). It contains no data and serves only as a marker
 * for queries (e.g., `PlayerTag`, `EnemyTag`).
 *
 * ---
 *
 * ### Choosing Schema Data Types
 *
 * The performance impact of choosing the smallest appropriate data type is significant. It's not just about
 * memory savings; it's about how efficiently the CPU can access and process data due to two key hardware principles:
 *
 * 1.  **CPU Cache Lines**: When your CPU needs to read a piece of data from memory (like a
 *     character's state), it doesn't just fetch that single byte. It fetches a whole "cache line,"
 *     which is typically 64 bytes.
 *     - If you use **`u8`** (1 byte), that single memory fetch pulls in the state for **64 different entities**.
 *     - If you use **`u32`** (4 bytes), that same fetch only gets the state for **16 entities**.
 *     - If you use **`f64`** (8 bytes), it only gets the state for **8 entities**.
 *     By using smaller types, you maximize the amount of useful data you get with every memory read, leading to
 *     fewer "cache misses" and a massive performance gain in tight loops.
 *
 * 2.  **SIMD (Single Instruction, Multiple Data)**: Modern CPUs can perform the same operation
 *     on multiple pieces of data at once. JavaScript engines like V8 could theoretically apply
 *     "auto-vectorizing" for simple loops over `TypedArray`s, converting them into
 *     SIMD instructions. A loop that adds gravity to a `Velocity` component, for instance, can
 *     be executed on 4, 8, or 16 entities simultaneously with a single instruction.
 *
 * When defining a component schema, select the most appropriate `TypedArray` type:
 *
 * - **`f64` (Float64Array)**: Use for high-precision floating-point numbers, especially for core
 *   physics and transform data (`Position`, `Velocity`). This matches JavaScript's native `Number`
 *   type, preventing precision loss and conversion overhead.
 * - **`f32` (Float32Array)**: Good for less critical floats where memory is a concern (e.g., `MovementIntent`).
 *   Also, the standard for GPU-bound data like vertex attributes.
 * - **`u32` (Uint32Array)**: Range `0` to `4,294,967,295`. A great general-purpose unsigned integer for
 *   values that will never be negative, like entity IDs, scores, experience points, or timestamps.
 * - **`i32` (Int32Array)**: Range `-2,147,483,648` to `2,147,483,647`. A good general-purpose signed integer
 *   for large values that can be negative.
 * - **`u16` (Uint16Array)**: Range `0` to `65,535`. Suitable for values that won't exceed this range,
 *   like item quantities in an inventory, or health/mana if you know it won't go above 65k.
 * - **`i16` (Int16Array)**: Range `-32,768` to `32,767`. Good for values that can be moderately negative
 *   or positive, like screen coordinates relative to a center point.
 * - **`u8` (Uint8Array)**: Range `0` to `255`. Excellent for flags, booleans (0 or 1), enumerations with
 *   a small number of states, or values that will never exceed 255, like a percentage.
 * - **`i8` (Int8Array)**: Range `-128` to `127`. Good for small signed integers, like a direction
 *   vector component (-1, 0, or 1).
 *
 */
const { loadAllComponents } = await import(`${PATH_MANAGERS}/ComponentManager/componentLoader.js`)
const { schemaCompiler } = await import('./SchemaCompiler.js')
const { componentInterpreter } = await import('./ComponentInterpreter.js')
const { stringInterningTable } = await import(`${PATH_CLIENT}/Indirection/StringInterningTable.js`)

/**
 * The maximum number of unique component types the engine can support.
 * This value is the single source of truth for the engine's bitmasking system.
 * It is critical for:
 * 1.  **ArchetypeManager**: Generating a unique bitmask ID for each archetype.
 * 2.  **QueryManager/Query**: Performing fast, bitwise matching of queries against archetypes.
 * @type {number}
 *
 * If this limit is ever reached, it must be increased here.
 */
export const MAX_COMPONENTS = 256
/**
 * @property {number} nextComponentTypeID - The next available ID to be assigned to a new component type.
 */
export class ComponentManager {
	constructor() {
		this.componentNames = [] // Indexed by typeID
		this.componentInfo = [] // Indexed by typeID, stores parsed schema info
		this.componentConstants = [] // Indexed by typeID
		this.compiledDefaults = [] // Indexed by typeID
		this.componentBitFlags = [] // Indexed by typeID, stores BigInt bit flags
		this.componentNameToTypeID = new Map() // Maps lowercase name to typeID
		this.nextComponentTypeID = 0
		this.sharedGroupManager = null // self-reference after init
		this.archetypeManager = null // self-reference after init
		this.entityManager = null // self-reference after init
		this._cachedComponentsObject = null
		this.EMPTY_BITMASK = 0n
	}

	async init() {
		const componentModules = await loadAllComponents()
		this.entityManager = (await import(`${PATH_MANAGERS}/EntityManager/EntityManager.js`)).entityManager
		await this.registerComponents(componentModules)
		this.sharedGroupManager = (
			await import(`${PATH_MANAGERS}/SharedGroupManager/SharedGroupManager.js`)
		).sharedGroupManager
		this.archetypeManager = (await import(`${PATH_MANAGERS}/ArchetypeManager/ArchetypeManager.js`)).archetypeManager
		componentInterpreter.init({
			componentManager: this,
		})
	}

	async registerComponents(componentModules) {
		// Register all the loaded component classes.
		for (const { moduleName, module, category } of componentModules) {
			const componentSchema = module.default || module[moduleName]
			//default exports are allowed, but ew
			if (componentSchema && typeof componentSchema === 'object') {
				this.registerComponent(moduleName, componentSchema)
			} else {
				console.error(`ComponentManager: Could not find component object export in module "${moduleName}".`)
			}
		}
	}

	/**
	 * Registers a component schema object with the manager.
	 * If already registered, it does nothing.
	 * @param {string} componentName - The name of the component.
	 * @param {object} schema - The component's schema object.
	 */
	registerComponent(componentName, schema) {
		if (!componentName || !schema) {
			console.error('ComponentManager: Cannot register a component without a name or schema.')
			return
		}

		if (this.nextComponentTypeID >= MAX_COMPONENTS) {
			const errorMsg = `ComponentManager: Cannot register component ${componentName}. Maximum component limit of ${MAX_COMPONENTS} reached.`
			console.error(errorMsg)
			// This is a critical architectural limit. Throwing an error stops execution
			// and makes it clear that MAX_COMPONENTS needs to be increased if this is intentional.
			throw new Error(errorMsg)
		}

		const lowerCaseName = componentName.toLowerCase()
		if (!this.componentNameToTypeID.has(lowerCaseName)) {
			const typeID = this.nextComponentTypeID++
			this.componentNames[typeID] = componentName
			this.componentBitFlags[typeID] = 1n << BigInt(typeID) // Assign a unique bit flag
			this._parseAndStoreSchema(componentName, schema, typeID)

			// Store by canonical (lowercase) name for case-insensitive lookup
			this.componentNameToTypeID.set(lowerCaseName, typeID)

			// Invalidate the cache whenever a new component is registered.
			this._cachedComponentsObject = null
		}
	}

	/**
	 * Parses a component's schema and stores the structured information for the ArchetypeManager.
	 * @param {string} componentName - The name of the component.
	 * @param {object} schema - The component's schema object.
	 * @param {number} typeID - The component's type ID.
	 * @private
	 */
	_parseAndStoreSchema(componentName, schema, typeID) {
		// Instantiate the unified compiler. It handles both parsing and program generation.

		const { componentInfo, constants, compiledDefaults } = schemaCompiler.compile(componentName, schema, typeID)
		this.componentInfo[typeID] = componentInfo
		this.componentConstants[typeID] = constants
		this.compiledDefaults[typeID] = Object.freeze(compiledDefaults)
	}

	/**
	 * Takes a high-level, "designer-friendly" component data object and converts it
	 * into a "engine-friendly" map of componentTypeID -> rawData. This involves
	 * processing the data (e.g., interning strings, converting enums) and handling
	 * shared component data grouping.
	 * @param {object} componentsInput - e.g., `{ Position: { x: 10 }, Rarity: { value: 'common' } }`
	 * @returns {Map<number, object>} A map of componentTypeID to its processed, raw data object.
	 */
	createIdMapFromData(componentsInput) {
		const perEntityDataMap = new Map()
		const sharedDataPayload = {}

		if (!componentsInput) {
			return perEntityDataMap
		}

		// --- Stage 1: Process and Separate ---
		for (const componentName in componentsInput) {
			if (!Object.prototype.hasOwnProperty.call(componentsInput, componentName)) continue

			const typeID = this.getComponentTypeIDByName(componentName)
			if (typeID === undefined) continue
			const info = this.componentInfo[typeID]
			if (!info) continue

			let rawData = { ...componentsInput[componentName] } // Work on a copy
			componentInterpreter.process(typeID, rawData)

			const perEntityPart = { ...rawData }
			const sharedPart = {}
			let hasSharedPart = false

			for (const sharedPropName of info.sharedProperties) {
				if (perEntityPart[sharedPropName] !== undefined) {
					sharedPart[sharedPropName] = perEntityPart[sharedPropName]
					delete perEntityPart[sharedPropName]
					hasSharedPart = true
				}
			}

			perEntityDataMap.set(typeID, perEntityPart)
			if (hasSharedPart) {
				sharedDataPayload[typeID] = sharedPart
			}
		}

		// --- Stage 2: Group Shared Data and Inject groupId ---
		if (Object.keys(sharedDataPayload).length > 0) {
			const groupId = this.sharedGroupManager.getGroupId(sharedDataPayload)
			for (const typeIDStr in sharedDataPayload) {
				perEntityDataMap.get(Number(typeIDStr)).groupId = groupId
			}
		}

		return perEntityDataMap
	}

	/**
	 * Reconstructs a "designer-friendly" component data object from the raw,
	 * engine-friendly data stored in a chunk. This is the "read" path replacement
	 * for the old ComponentInterpreter.
	 * @param {number} entityId The ID of the entity to read from.
	 * @param {number} typeID The component's type ID.
	 * @returns {object | undefined} The reconstructed component data, or undefined if not found.
	 */
	reconstructComponentData(entityId, typeID) {
		const archetypeId = this.entityManager.getArchetypeForEntity(entityId)
		if (archetypeId === undefined || !this.hasComponent(archetypeId, typeID)) {
			return undefined
		}

		const location = this.archetypeManager.archetypeEntityMaps[archetypeId]?.get(entityId)
		if (!location) return undefined

		const { chunk, indexInChunk } = location
		const componentData = {}
		const info = this.componentInfo[typeID]
		const componentArrays = chunk.componentArrays[typeID]

		// Loop over all representations, not just original keys, to handle composite types like 'rpn'.
		for (const propName in info.representations) {
			const rep = info.representations[propName]
			if (!rep || rep.shared) continue

			switch (rep.type) {
				case 'rpn':
					// This is a composite type. Its underlying flat_arrays will be handled
					// individually by this loop. Do nothing for the parent property itself.
					break
				case 'flat_array': {
					const sourceArray = []
					const len = componentArrays[rep.lengthProperty][indexInChunk]
					const itemRep = rep.itemRepresentation
					for (let i = 0; i < len; i++) {
						const rawValue = componentArrays[`${propName}${i}`][indexInChunk]
						if (itemRep.type === 'string') {
							sourceArray.push(stringInterningTable.get(rawValue))
						} else if (itemRep.type === 'enum') {
							sourceArray.push(itemRep.valueMap[rawValue])
						} else {
							sourceArray.push(rawValue)
						}
					}
					componentData[propName] = sourceArray
					break
				}
				case 'enum':
					componentData[propName] = rep.valueMap[componentArrays[propName][indexInChunk]]
					break
				case 'bitmask':
					const rawValue = componentArrays[propName][indexInChunk]
					const flags = []
					for (const flagName in rep.flagMap) {
						if ((rawValue & rep.flagMap[flagName]) !== 0) flags.push(flagName)
					}
					componentData[propName] = flags
					break
				case 'string':
					componentData[propName] = stringInterningTable.get(componentArrays[propName][indexInChunk])
					break
				default: // Primitives
					if (componentArrays && componentArrays[propName]) {
						componentData[propName] = componentArrays[propName][indexInChunk]
					}
					break
			}
		}

		// Add the groupId if the component has shared properties
		if (info.sharedProperties.length > 0 && componentArrays?.groupId) {
			componentData.groupId = componentArrays.groupId[indexInChunk]
		}

		return componentData
	}

	/**
	 * Reconstructs a "designer-friendly" shared data object from its raw,
	 * engine-friendly format. This is used when retrieving component data that
	 * includes shared properties.
	 * @param {number} typeID The component's type ID.
	 * @param {object} rawSharedData The raw shared data object (e.g., `{ value: 13 }`).
	 * @returns {object} The reconstructed shared data (e.g., `{ value: 'common' }`).
	 */
	reconstructSharedData(typeID, rawSharedData) {
		const reconstructedData = {}
		const info = this.componentInfo[typeID]

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

	/**
	 * Gets the component's string name for a given ID.
	 * This is useful for debugging and logging.
	 * @param {number} typeID - The component type ID.
	 * @returns {string | undefined} The component's name, or undefined if ID is invalid.
	 */
	getComponentNameByTypeID(typeID) {
		return this.componentNames[typeID]
	}

	/**
	 * Gets the unique ID for a registered component class by its name.
	 * This is a high-performance, direct lookup.
	 * @param {string} name - The name of the component class.
	 * @returns {number | undefined} The ID, or undefined if not registered.
	 */
	getComponentTypeIDByName(name) {
		return this.componentNameToTypeID.get(name.toLowerCase())
	}

	/**
	 * Retrieves an object containing all registered component constants,
	 * keyed by their names. This is for easy access in systems, e.g., `const { Position, Velocity } = componentManager.getComponents()`
	 * @returns {Object.<string, object>} An object mapping component names to their constants object.
	 */
	getComponents() {
		if (this._cachedComponentsObject) {
			return this._cachedComponentsObject
		}

		this._cachedComponentsObject = {}
		for (let i = 0; i < this.nextComponentTypeID; i++) {
			const name = this.componentNames[i]
			this._cachedComponentsObject[name] = this.componentConstants[i]
		}

		return this._cachedComponentsObject
	}

	/**
	 * Retrieves an object mapping all registered component names to their numeric type IDs.
	 * This is ideal for destructuring in a system's constructor for clean, cached access.
	 * e.g., `const { Position, Velocity } = this.componentManager.getTypeIDs();`
	 * @returns {Object.<string, number>} An object mapping component names to their type IDs.
	 */
	getTypeIDs() {
		const idMap = {}
		for (let i = 0; i < this.nextComponentTypeID; i++) {
			const name = this.componentNames[i]
			if (name) {
				idMap[name] = i
			}
		}
		return idMap
	}

	/**
	 * Retrieves the static constant map (for enums or bitmasks) for a specific component.
	 * @param {string|number} componentIdentifier - The component name or typeID.
	 * @returns {object | undefined} The read-only constant map (e.g., `{ STATE: { IDLE: 0, ... } }`), or undefined if not found.
	 */
	getConstantsFor(componentIdentifier) {
		const typeID =
			typeof componentIdentifier === 'string' ? this.getComponentTypeIDByName(componentIdentifier) : componentIdentifier
		if (typeID === undefined) return undefined
		return this.componentConstants[typeID]
	}

	/**
	 * Retrieves the static constant map (for enums or bitmasks) for a specific property of a component.
	 * This is a developer-friendly helper for system initialization.
	 * @param {string|number} componentIdentifier - The name or typeID of the component.
	 * @param {string} propertyName - The name of the property in the component's schema (e.g., 'collisionFlags').
	 * @returns {object | undefined} The read-only constant map (e.g., `{ LEFT: 1, RIGHT: 2, ... }`), or undefined if not found.
	 */
	getConstantsForProperty(componentIdentifier, propertyName) {
		const componentConstants = this.getConstantsFor(componentIdentifier)
		if (!componentConstants) {
			console.warn(`ComponentManager: Could not find constants for component "${componentIdentifier}".`)
			return undefined
		}

		const propertyConstants = componentConstants[propertyName.toUpperCase()]
		if (!propertyConstants) {
			console.warn(
				`ComponentManager: Could not find constants for property "${propertyName}" on component "${componentIdentifier}".`
			)
			return undefined
		}

		return propertyConstants
	}

	/**
	 * Gets a cached, pre-compiled object of a component's default values.
	 * This is used to get default values for "Hot" components without creating a new object every time.
	 * The instance is created once per component type and cached globally.
	 * @param {number} typeID - The component type ID.
	 * @returns {object|undefined} The cached object of compiled default values.
	 */
	getCompiledDefaults(typeID) {
		return this.compiledDefaults[typeID]
	}

	/**
	 * Gets an array of component names from a bitmask.
	 * @param {bigint} mask - The bitmask to resolve.
	 * @returns {string[]} An array of component names.
	 */
	getComponentNamesFromMask(mask) {
		const names = []
		for (let i = 0; i < this.nextComponentTypeID; i++) {
			if ((mask & this.componentBitFlags[i]) !== 0n) {
				names.push(this.componentNames[i])
			}
		}
		return names
	}

	/**
	 * Gets an array of component type IDs from a bitmask.
	 * The returned array is implicitly sorted because it's generated by iterating
	 * through type IDs in ascending order.
	 * @param {bigint} mask - The bitmask to resolve.
	 * @returns {number[]} An array of component type IDs.
	 */
	getComponentTypesFromMask(mask) {
		const types = []
		for (let i = 0; i < this.nextComponentTypeID; i++) {
			if ((mask & this.componentBitFlags[i]) !== 0n) {
				types.push(i)
			}
		}
		return types
	}

	/**
	 * Gets an array of component names for a given archetype ID.
	 * This is useful for debugging and logging.
	 * @param {number} archetypeId - The archetype ID.
	 * @returns {string[]} An array of component names.
	 */
	getComponentNamesForArchetype(archetypeId) {
		const typeIDs = this.archetypeManager.archetypeComponentTypeIDs[archetypeId]
		if (!typeIDs) {
			// This can happen if the archetypeId is invalid or not yet fully registered.
			console.warn(`ComponentManager: Could not find type IDs for archetype ${archetypeId}.`)
			return []
		}
		// The 'typeIDs' is a Set. Convert it to an array to map over it.
		return [...typeIDs].map(id => this.getComponentNameByTypeID(id))
	}

	/**
	 * Checks if an archetype has a specific component.
	 * This is the fastest possible check, intended for use within system loops where
	 * the archetype ID is already known. It checks the archetype's structure.
	 * @param {number} archetypeId - The internal ID of the archetype to check.
	 * @param {number} archetype - The internal ID of the archetype to check.
	 * @returns {boolean} True if the archetype contains the component type, false otherwise.
	 */
	hasComponent(archetype, componentTypeID) {
		// This check operates on the archetype's structure, not a specific entity,
		// as all entities in an archetype have the same components.
		if (archetype === undefined) {
			return false
		}
		return this.archetypeManager.hasComponentType(archetype, componentTypeID)
	}
}

export const componentManager = new ComponentManager()
