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
const { loadAllComponents } = await import(`${PATH_ECS}/ComponentManager/componentLoader.js`)
const { schemaCompiler } = await import('./SchemaCompiler.js')
const { componentDataReconstructor } = await import('./ComponentDataReconstructor.js')

import * as Schema from './ComponentSchema.js'

/**
 * Converts a PascalCase string to a smart camelCase, correctly handling acronyms at the start of the string.
 * - `Position` -> `position`
 * - `PlayerTag` -> `playerTag`
 * - `RWMTag` -> `rwmTag` (acronym at the start)
 * - `URLShortener` -> `urlShortener` (acronym followed by another word)
 * - `PlayerID` -> `playerID` (acronyms not at the start are treated as regular PascalCase)
 *
 * Note: This function is designed to only handle acronyms at the beginning of a string.
 * Mid-string acronyms are intentionally not converted to lowercase to keep the logic simple and predictable.
 * For example, `PlayerID` becomes `playerID`, not `playerId`.
 *
 * @param {string} str The PascalCase string to convert.
 * @returns {string} The camelCased string.
 */
function toCamelCase(str) {
	if (!str) return '';

	// Match the initial sequence of uppercase letters.
	const acronymRegex = /^[A-Z0-9]+(?=[A-Z0-9][a-z]|$)/;
	const match = str.match(acronymRegex);

	if (match) {
		// This is an acronym (like RWM or URL). Lowercase the whole acronym.
		const acronym = match[0];
		return acronym.toLowerCase() + str.slice(acronym.length);
	} else {
		// This is standard PascalCase (like Position or FlatArray). Lowercase only the first letter.
		return str.charAt(0).toLowerCase() + str.slice(1)
	}
}

export class ComponentManager {
	constructor() {
		// The manager no longer holds the data itself. It orchestrates the population
		// of the standalone ComponentSchema module.
		// For backward compatibility during refactoring, it provides getters that
		// point to the new central data store.
		this.componentInfo = Schema.componentInfo
		this.componentConstants = Schema.componentConstants
		this.compiledDefaults = Schema.compiledDefaults

		this.archetypeManager = null // self-reference after init
		this.propertyGroupManager = null // self-reference after init
		this.entityManager = null // self-reference after init
		this._cachedComponentsObject = null
		this.EMPTY_BITMASK = 0n
	}

	get nextComponentTypeID() {
		return Schema.nextComponentTypeID
	}

	async init() {
		const componentModules = await loadAllComponents()

		const { theManager} = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)

		const { entityManager, prefabManager, archetypeManager } = theManager.getManagers()
		this.entityManager = entityManager
		this.prefabManager = prefabManager
		this.archetypeManager = archetypeManager

		// Explicitly import managers we depend on that initialize before us.

		this.propertyGroupManager = (await import(`${PATH_INDIRECT}/PropertyGroupManager/PropertyGroupManager.js`)).propertyGroupManager
		await this.registerComponents(componentModules)
		componentDataReconstructor.init({
			archetypeManager: this.archetypeManager,
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

		if (Schema.nextComponentTypeID >= Schema.MAX_COMPONENTS) {
			const errorMsg = `ComponentManager: Cannot register component ${componentName}. Maximum component limit of ${Schema.MAX_COMPONENTS} reached.`
			console.error(errorMsg)
			// This is a critical architectural limit. Throwing an error stops execution
			// and makes it clear that MAX_COMPONENTS needs to be increased if this is intentional.
			throw new Error(errorMsg)
		}

		const lowerCaseName = componentName.toLowerCase()
		if (!Schema.componentNameToTypeID.has(lowerCaseName)) {
			const typeID = Schema.nextComponentTypeID
			Schema.setNextComponentTypeID(typeID + 1)

			// Convert to camelCase and store it as the canonical name.
			Schema.componentNames[typeID] = toCamelCase(componentName)
			Schema.componentBitFlags[typeID] = 1n << BigInt(typeID) // Assign a unique bit flag
			this._parseAndStoreSchema(componentName, schema, typeID)

			// Store by canonical (lowercase) name for case-insensitive lookup
			Schema.componentNameToTypeID.set(lowerCaseName, typeID)

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
		Schema.componentInfo[typeID] = componentInfo
		Schema.componentConstants[typeID] = constants
		Schema.compiledDefaults[typeID] = Object.freeze(compiledDefaults)
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
		return componentDataReconstructor.reconstruct(entityId, typeID)
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
		return componentDataReconstructor.reconstructShared(typeID, rawSharedData)
	}

	/**
	 * Gets the component's string name for a given ID.
	 * This is useful for debugging and logging.
	 * @param {number} typeID - The component type ID.
	 * @returns {string | undefined} The component's name, or undefined if ID is invalid.
	 */
	getComponentNameByTypeID(typeID) {
		return Schema.componentNames[typeID]
	}

	/**
	 * Gets the unique ID for a registered component class by its name.
	 * This is a high-performance, direct lookup.
	 * @param {string} name - The name of the component class.
	 * @returns {number | undefined} The ID, or undefined if not registered.
	 */
	getComponentTypeIDByName(name) {
		return Schema.componentNameToTypeID.get(name.toLowerCase())
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
		for (let i = 0; i < Schema.nextComponentTypeID; i++) {
			const name = Schema.componentNames[i] // This is now camelCase
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
		for (let i = 0; i < Schema.nextComponentTypeID; i++) {
			const name = Schema.componentNames[i] // This is now camelCase
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
			typeof componentIdentifier === 'string'
				? Schema.componentNameToTypeID.get(componentIdentifier.toLowerCase())
				: componentIdentifier
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
		return Schema.compiledDefaults[typeID]
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
		return [...typeIDs].map(id => Schema.componentNames[id])
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
