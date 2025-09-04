/**
 * @fileoverview Manages component registration, schema parsing, and low-level component manipulation.
 *
 * ---
 *
 * ### Architectural Philosophy: A Unified "Hot" Data Model
 *
 * This manager is central to the engine's data-oriented design. The core principle is that
 * **all** component data is stored in a "hot", cache-friendly format to maximize performance.
 *
 * #### Hot Components (Struct-of-Arrays, SoA)
 *
 * Hot components are for performance-critical data that is frequently accessed and modified
 * in tight loops (e.g., Position, Velocity, Health).
 *
 * - **Schema-Driven**: They are defined by a `static schema` object that maps property names
 *   to primitive types (e.g., `{ x: 'f64', y: 'f64' }`).
 * - **Storage**: The `Archetype` stores their data in `TypedArray`s, one for each property.
 *   This is the "Struct-of-Arrays" (SoA) layout, which is extremely cache-friendly for systems
 *   that iterate over specific properties.
 * - **Access**: Systems use a high-performance `SoAComponentAccessor` which provides a
 *   reusable "view" object, avoiding object allocation in loops.
 * - **All Components are Hot**: In this engine, all components are considered "hot" and must
 *   provide a `static schema`. There is no "cold" data path. This ensures predictable high
 *   performance and architectural simplicity.
 * - **Complex Data**: For complex data that doesn't fit in a `TypedArray` (like a `Map` or a
 *   `PIXI.Sprite`), components should store a numeric reference (a "handle" or "Ref") to the
 *   object, which is managed by a specialized manager (e.g., `AssetManager`).
 *
 * #### Tag Components
 *
 * A tag is a special type of "hot" component that contains no data. It is defined as a
 * schemaless class with no instance properties (e.g., `class MyTag {}`). It serves only
 * as a marker for queries (e.g., `PlayerTag`, `EnemyTag`).
 *
 * ---
 *
 * ### Choosing Schema Data Types
 *
 * The performance impact of choosing the smallest appropriate data type goes beyond just memory savings;
 * it's about how efficiently the CPU can access and process that data. This is due to two key
 * hardware principles:
 *
 * 1.  **CPU Cache Lines**: When your CPU needs to read a piece of data from memory (like a
 *     character's state), it doesn't just fetch that single byte. It fetches a whole "cache line,"
 *     which is typically 64 bytes.
 *     - If you use **`u8`** (1 byte), that single memory fetch pulls in the state for **64 different entities**.
 *     - If you use **`u32`** (4 bytes), that same fetch only gets the state for **16 entities**.
 *     - If you use **`f64`** (8 bytes), it only gets the state for **8 entities**.
 *     By using smaller types, you maximize the amount of useful data you get with every memory
 *     read, leading to fewer "cache misses" and a massive performance gain in tight loops.
 *
 * 2.  **SIMD (Single Instruction, Multiple Data)**: Modern CPUs can perform the same operation
 *     on multiple pieces of data at once. JavaScript engines like V8 are extremely good at
 *     "auto-vectorizing" simple loops over `TypedArray`s, converting them into these powerful
 *     SIMD instructions. A loop that adds gravity to a `Velocity` component, for instance, can
 *     be executed on 4, 8, or even 16 entities simultaneously with a single instruction.
 *
 * When defining a "hot" component schema, select the most appropriate `TypedArray` type:
 *
 * - **`f64` (Float64Array)**: Use for high-precision floating-point numbers, especially for core
 *   physics and transform data (`Position`, `Velocity`). This matches JavaScript's native `Number`
 *   type, preventing precision loss and conversion overhead.
 * - **`f32` (Float32Array)**: Good for less critical floats where memory is a concern (e.g., `MovementIntent`).
 *   Also the standard for GPU-bound data like vertex attributes.
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

const { StringManager } = await import('./StringManager.js')
const { SchemaParser } = await import(`${PATH_MANAGERS}/ComponentManager/SchemaParser.js`)
const { ComponentProcessor } = await import('./ComponentProcessor.js')
const { loadAllComponents } = await import(`${PATH_MANAGERS}/ComponentManager/componentLoader.js`)

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
 * @property {Map<Function, number>} componentTypes - Maps component class (constructor) to a unique ID.
 * @property {Function[]} componentClasses - Array of component classes, indexed by their ID for quick lookups.
 * @property {Map<string, Function>} componentNameToClass - Maps a component's lowercase name to its class constructor.
 * @property {number} nextComponentTypeID - The next available ID to be assigned to a new component type.
 */
export class ComponentManager {
	constructor() {
		this.componentTypes = new Map()
		this.componentClasses = [] // Indexed by typeID
		this.componentInfo = [] // Indexed by typeID, stores parsed schema info
		this.componentProcessors = [] // Indexed by typeID, stores generated processor functions
		this.componentBitFlags = [] // Indexed by typeID, stores BigInt bit flags
		this.componentNameToTypeID = new Map() // Maps lowercase name to typeID
		this.componentNameToClass = new Map()
		this.statNameToClassMap = new Map()
		this.stringManager = new StringManager()
		this.defaultInstances = [] // Indexed by typeID
		this.nextComponentTypeID = 0
		this.archetypeManager = null // self-reference after init
		this.componentProcessor = new ComponentProcessor(this)
		this.schemaParser = new SchemaParser()
		this._cachedComponentsObject = null
		this.EMPTY_BITMASK = 0n
	}

	async init() {
		const componentModules = await loadAllComponents()
		await this.registerComponents(componentModules)
		this.archetypeManager = (await import(`${PATH_MANAGERS}/ArchetypeManager/ArchetypeManager.js`)).archetypeManager
	}

	async registerComponents(componentModules) {
		// Register all the loaded component classes.
		for (const { moduleName, module, category } of componentModules) {
			const ComponentClass = module[moduleName]
			if (ComponentClass && typeof ComponentClass === 'function') {
				this.registerComponent(ComponentClass)
			} else {
				console.error(`ComponentManager: Could not find component class export "${moduleName}" in its module.`)
			}
		}
	}

	/**
	 * Registers a component class with the manager.
	 * If already registered, it does nothing.
	 * @param {Function} ComponentClass - The component class (constructor) to register.
	 */
	registerComponent(ComponentClass) {
		if (!ComponentClass) {
			console.error('ComponentManager: Cannot register an undefined or null component class.')
			return
		}

		if (this.nextComponentTypeID >= MAX_COMPONENTS) {
			const errorMsg = `ComponentManager: Cannot register component ${ComponentClass.name}. Maximum component limit of ${MAX_COMPONENTS} reached.`
			console.error(errorMsg)
			// This is a critical architectural limit. Throwing an error stops execution
			// and makes it clear that MAX_COMPONENTS needs to be increased if this is intentional.
			throw new Error(errorMsg)
		}

		if (!this.componentTypes.has(ComponentClass)) {
			const typeID = this.nextComponentTypeID++
			this.componentTypes.set(ComponentClass, typeID)
			this.componentClasses[typeID] = ComponentClass // Store class by ID
			this.componentBitFlags[typeID] = 1n << BigInt(typeID) // Assign a unique bit flag
			this._parseAndStoreSchema(ComponentClass, typeID)

			// Store by canonical (lowercase) name for case-insensitive lookup
			this.componentNameToClass.set(ComponentClass.name.toLowerCase(), ComponentClass)
			this.componentNameToTypeID.set(ComponentClass.name.toLowerCase(), typeID)

			// If the component self-identifies as a stat, register it for fast lookup.
			if (ComponentClass.statName) {
				this.statNameToClassMap.set(ComponentClass.statName, ComponentClass)
			}

			// Invalidate the cache whenever a new component is registered.
			this._cachedComponentsObject = null
			//console.log(`Component registered: ${ComponentClass.name} with ID ${typeID}`)
		}
	}

	/**
	 * Parses a component's schema and stores the structured information for the ArchetypeManager.
	 * @param {Function} ComponentClass - The component class.
	 * @param {number} typeID - The component's type ID.
	 * @private
	 */
	async _parseAndStoreSchema(ComponentClass, typeID) {
		const info = await this.schemaParser.parse(ComponentClass, typeID, this.stringManager)
		this.componentInfo[typeID] = info
		this._generateComponentProcessor(ComponentClass, typeID, info)
	}

	/**
	 * Generates and caches a processor function for a specific component type.
	 * This function is a "pipeline" that calls the necessary generic processors from the
	 * registry in a fixed order, avoiding all runtime loops and lookups.
	 * @param {Function} ComponentClass - The component class.
	 * @param {number} typeID - The component's type ID.
 * @param {object} info - The parsed schema information from SchemaParser.
	 * @private
	 */
	_generateComponentProcessor(ComponentClass, typeID, info) {
		const processingSteps = []

		// Use representations which is the source of truth for processors
		for (const propName in info.representations) {
			const rep = info.representations[propName]

			if (rep.type) {
				const typeProcessorFunc = this.componentProcessor.typeRegistry[rep.type]
				// Only include processors that exist in the generic, runtime registry.
				//! Prefab-specific processors should be processed at build \ load time once.
				if (typeProcessorFunc) {
					processingSteps.push({
						typeProcessor: typeProcessorFunc,
						propName,
						propSchema: rep,
					})
				}
			}
		}

		if (processingSteps.length === 0) {
			this.componentProcessors[typeID] = null // No processor needed for this component.
			return
		}

		const specializedProcessor = (rawData, componentName) => {
			// OPTIMIZATION: Mutate the original rawData object directly.
			// The shallow copy `{ ...rawData }` was identified as a major performance bottleneck,
			// causing excessive garbage collection during entity creation.
			// The type processors in ComponentProcessor.js are designed to mutate the object they receive.
			for (const step of processingSteps) {
				// Pass the specific property and its schema to the processor.
				// This is much more efficient than having the processor loop through the whole schema.
				step.typeProcessor(rawData, step.propName, step.propSchema, componentName)
			}
			return rawData
		}

		this.componentProcessors[typeID] = specializedProcessor
	}

	/**
	 * Gets the unique ID for a registered component class.
	 * @param {Function} ComponentClass - The component class.
	 * @returns {number | undefined} The ID, or undefined if not registered.
	 */
	getComponentTypeID(ComponentClass) {
		const typeID = this.componentTypes.get(ComponentClass)
		if (typeID === undefined) {
			const componentName = ComponentClass ? ComponentClass.name : 'undefined'
			console.warn(`ComponentManager: Could not get type ID for component "${componentName}". It might not be registered.`)
		}
		return typeID
	}

	/**
	 * Gets the unique BigInt bit flag for a registered component class.
	 * @param {Function} ComponentClass - The component class.
	 * @returns {bigint | undefined} The bit flag, or undefined if not registered.
	 */
	getComponentBitFlag(ComponentClass) {
		const typeID = this.componentTypes.get(ComponentClass)
		return typeID !== undefined ? this.componentBitFlags[typeID] : undefined
	}

	/**
	 * Gets the component's string name for a given ID.
	 * This is useful for debugging and logging.
	 * @param {number} typeID - The component type ID.
	 * @returns {string | undefined} The component's name, or undefined if ID is invalid.
	 */
	getComponentNameByTypeID(typeID) {
		const ComponentClass = this.componentClasses[typeID]
		return ComponentClass ? ComponentClass.name : undefined
	}

	/**
	 * Gets the component class for a given ID.
	 * @param {number} typeID - The component type ID.
	 * @returns {Function | undefined} The component class, or undefined if ID is invalid.
	 */
	getComponentClassByTypeID(typeID) {
		return this.componentClasses[typeID]
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
	 * Gets the component class for a given name.
	 * Do not use it for performance - critical parts of a game.
	 * @param {string} name - The name of the component class.
	 * @returns {Function | undefined} The component class constructor, or undefined if not found.
	 */
	getComponentClassByName(name) {
		return this.componentNameToClass.get(name.toLowerCase())
	}

	/**
	 * Gets the component class for a given stat name.
	 * This is a highly performant lookup for data-driven systems.
	 * @param {string} statName - The canonical (lowercase) name of the stat.
	 * @returns {Function | undefined} The component class constructor, or undefined if not found.
	 */
	getComponentClassByStatName(statName) {
		return this.statNameToClassMap.get(statName)
	}

	/**
	 * Retrieves an object containing all registered component classes,
	 * keyed by their class names.
	 * @returns {Object.<string, Function>} An object mapping class names to ComponentClasses.
	 */
	getComponents() {
		if (this._cachedComponentsObject) {
			return this._cachedComponentsObject
		}

		const components = {}
		for (const [ComponentClass] of this.componentTypes.entries()) {
			if (!ComponentClass || !ComponentClass.name) {
				console.warn(`ComponentManager: An invalid component class was found during getComponents(). It has been skipped.`)
				continue
			}
			components[ComponentClass.name] = ComponentClass
		}
		this._cachedComponentsObject = components
		return this._cachedComponentsObject
	}

	/**
	 * Gets a cached, default instance of a component class.
	 * This is used to get default values for "Hot" components without creating a new object every time.
	 * The instance is created once per component type and cached globally.
	 * @param {number} typeID - The component type ID.
	 * @returns {object|undefined} The cached default instance.
	 */
	getDefaultInstance(typeID) {
		if (this.defaultInstances[typeID]) {
			return this.defaultInstances[typeID]
		}

		const ComponentClass = this.getComponentClassByTypeID(typeID)
		const instance = new ComponentClass()
		this.defaultInstances[typeID] = instance
		return instance
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
				names.push(this.componentClasses[i].name)
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

	readComponentData(entityId, componentTypeId, archetype) {
		return this.componentProcessor.read(entityId, componentTypeId, archetype)
	}
}

export const componentManager = new ComponentManager()