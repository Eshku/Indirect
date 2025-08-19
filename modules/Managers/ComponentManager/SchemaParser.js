/**
 * @fileoverview Parses component schemas into a structured format for the engine.
 * This class is responsible for interpreting the `static schema` property of components
 * and converting it into a detailed information object that the ArchetypeManager
 * can use to lay out data in memory efficiently.
 *
 * 
 *
 * ### Developer Note: Designing Component Schemas
 *
 * The `static schema` is the key to the engine's performance. It dictates how a
 * component's data is stored and accessed. Choosing the right schema type is crucial.
 *
 * #### "Hot" Components (Schema-Driven, Struct-of-Arrays)
 *
 * Components with a `static schema` are "Hot" components. Their data is stored in
 * cache-friendly `TypedArray`s (SoA), which is ideal for performance-critical systems.
 *
 * **1. Primitives (e.g., `f64`, `u8`)**
 *    - **Use Case**: The most common type, for simple numeric properties.
 *    - **Recommended Syntax**: `{ type: 'f64' }`
 *    - **Shorthand**: `'f64'` (Supported for brevity, but the object form is preferred for consistency).
 *    - **Example**: `Position: { x: { type: 'f64' }, y: { type: 'f64' } }`
 *
 * **2. Strings: Choose Your Storage Strategy**
 *    - **Interned (Default)**: `{ type: 'string' }` or `'string'`.
 *      - **Use Case**: For string data that is likely to be repeated across many entities (e.g., `DisplayName`, `PrefabId`).
 *      - **How it Works**: The engine interns these strings to save memory. See `StringInterningTable.js`. This is the best choice for most per-entity strings.
 *    - **Fixed-Capacity (Use Sparingly)**: `{ type: 'string', capacity: N }`.
 *      - **Alias**: `length` can be used instead of `capacity`.
 *      - **Use Case**: A specialized type for fixed-size, non-repeating byte sequences where absolute data locality is critical and memory waste is acceptable (e.g., a unique hex ID).
 *      - **How it Works**: Reserves a fixed number of bytes directly in the archetype's memory.
 *      - **Trade-off**: This avoids the pointer lookup of an interned string, but can be very wasteful if the actual string length is less than the capacity. It also does not benefit from deduplication.
 *      - **Example**: `UniqueId: { value: { type: 'string', capacity: 16 } }`
 *
 * **3. Enums (`{ type: 'enum', ... }`)**
 *    - **Use Case**: For a property that can only be in **one state at a time** from a
 *      list of mutually exclusive options (e.g., a trigger type).
 *    - **Example**: `Trigger: { on: { type: 'enum', of: 'u8', values: ['OnUse', 'OnHit'] } }`
 *
 * **4. Bitmasks (`{ type: 'bitmask', ... }`)**
 *    - **Use Case**: For properties that can be in **multiple states simultaneously**
 *      (e.g., a character's status effects).
 *    - **Example**: `PhysicsState: { flags: { type: 'bitmask', of: 'u8', values: ['GROUNDED', 'JUMPING'] } }`
 *
 * **5. Arrays (`{ type: 'array', ... }`)**
 *    - **Use Case**: For fixed-size collections of simple data, like an inventory hotbar holding entity IDs.
 *    - **Alias**: `length` can be used instead of `capacity`.
 *    - **Example**: `ActiveItems: { slots: { type: 'array', of: 'u32', capacity: 10 } }`
 *
 * #### "Cold" and "Tag" Components (Schemaless)
 *
 * **Tag Components**: A class with an empty schema (`static schema = {}`) or no schema and no
 * instance properties. They act as simple markers and have zero memory cost per entity.
 *
 * **Cold Components**: A class with no `static schema`. These are stored as regular JavaScript
 * objects (AoS). Use them for complex data (`Map`, `Set`), references to external objects
 * (e.g., PIXI DisplayObjects), or data that is accessed infrequently.
 */

/**
 * 
 *
 * ### Developer Note: Accessing Component Data in Systems
 *
 * Once components are defined, systems access their data within the main update loop. The access
 * pattern differs for "Hot" and "Cold" components, and choosing the right pattern is critical
 * for performance.
 *
 * #### Accessing "Hot" Data (The High-Performance Path)
 *
 * For "Hot" (SoA) components, always use direct `TypedArray` access to achieve maximum performance.
 * This pattern is designed to be highly optimizable by the JavaScript JIT compiler, often
 * enabling SIMD vectorization.
 *
 * The canonical loop structure:
 * ```javascript
 * // In system's constructor:
 * this.positionTypeID = componentManager.getComponentTypeID(Position);
 *
 * // In system's update loop:
 * for (const chunk of this.query.iter()) {
 *     const archetype = chunk.archetype;
 *
 *     // 1. Get the component's property arrays directly.
 *     const positions = archetype.componentArrays[this.positionTypeID];
 *
 *     // 2. **Hoist property access out of the inner loop.** This is a critical
 *     //    optimization that gives the JIT a stable reference to the TypedArray.
 *     const posX = positions.x;
 *     const posY = positions.y;
 *
 *     // 3. Iterate and perform work. This loop is now extremely fast.
 *     for (const entityIndex of chunk) {
 *         posX[entityIndex] *= 2;
 *         posY[entityIndex] *= 2;
 *     }
 * }
 * ```
 *
 * #### Accessing "Cold" Data
 *
 * For "Cold" (AoS) components, access is simpler. The component array holds direct references
 * to the component instances. While accessors can be used, direct array access is also possible
 * and slightly more performant by avoiding a function call.
 *
 * The canonical loop structure:
 * ```javascript
 * // In system's constructor:
 * this.viewableTypeID = componentManager.getComponentTypeID(Viewable);
 *
 * // In system's update loop:
 * for (const chunk of this.query.iter()) {
 *     const archetype = chunk.archetype;
 *     const viewables = archetype.componentArrays[this.viewableTypeID]; // Array of Viewable instances
 *     for (const entityIndex of chunk) {
 *         const viewableComponent = viewables[entityIndex];
 *         if (viewableComponent) {
 *             viewableComponent.sprite.visible = true;
 *         }
 *     }
 * }
 * ```
 */

const { FlattenedArrayView } = await import(`${PATH_MANAGERS}/ArchetypeManager/Views.js`)

export class SchemaParser {
	/**
	 * Parses a component's schema and stores the structured information.
	 * @param {Function} ComponentClass - The component class.
	 * @param {number} typeID - The component's type ID.
	 * @param {import('./StringInterningTable.js').StringInterningTable} stringInterningTable - The global string interning table.
	 * @returns {Promise<object>} The parsed component information object.
	 */
	async parse(ComponentClass, typeID, stringInterningTable) {
		const finalInfo = {
			typeID,
			storage: 'Cold', // Default storage type
			propertyKeys: [], // The final, expanded list of property keys for per-entity SoA layout
			representations: {}, // Maps original schema key to its representation info
			originalSchemaKeys: [], // The original keys from the component's schema definition
		}

		finalInfo.properties = {}
		const schema = ComponentClass.schema

		if (schema === undefined) {
			// No schema defined. Could be a Tag or a Cold component.
			// We inspect an instance to decide.
			this._detectStorageTypeForSchemaless(ComponentClass, finalInfo)
			return finalInfo
		}

		//  Schema exists: This is a "Hot" (SoA) or "Tag" component 
		finalInfo.storage = 'Hot'

		if (Object.keys(schema).length === 0) {
			// This is a "tag" component (e.g., `static schema = {}`).
			return finalInfo
		}

		//  Parse properties 
		const schemaKeys = Object.keys(schema).sort()
		finalInfo.originalSchemaKeys = [...schemaKeys]
		const implicitKeys = []
		for (const propName of schemaKeys) {
			const propDefinition = schema[propName]
			this._parseProperty(ComponentClass.name, propName, propDefinition, finalInfo, implicitKeys, ComponentClass, stringInterningTable)
		}

		// Add any implicitly created keys (like 'count') to the list of schema keys
		// so they are available on component views, then sort for determinism.
		finalInfo.originalSchemaKeys.push(...implicitKeys)
		finalInfo.originalSchemaKeys.sort()

		// Sort final property keys for deterministic array layout and to remove duplicates
		finalInfo.propertyKeys = [...new Set(finalInfo.propertyKeys)].sort()

		return finalInfo
	}

	/**
	 * Parses a single property from a component schema.
	 * This acts as a dispatcher to the correct parsing helper based on the property definition's type.
	 * @param {string} componentName - The name of the component class, for error messages.
	 * @param {string} propName - The name of the property being parsed.
	 * @param {string|object} propDefinition - The schema definition for the property.
	 * @param {object} finalInfo - The component info object being built.
	 * @param {string[]} implicitKeys - An array to collect keys created implicitly (e.g., `_count`).
	 * @private
	 */_parseProperty(componentName, propName, propDefinition, finalInfo, implicitKeys, ComponentClass, stringInterningTable) {
		let definitionObject = propDefinition
		if (typeof propDefinition === 'string') {
			// Normalize shorthand string to a definition object.
			// 'f64' becomes { type: 'f64' }
			// 'string' becomes { type: 'string' }
			definitionObject = { type: propDefinition }
		}

		if (typeof definitionObject === 'object' && definitionObject.type) {
			this._parseComplexProperty(componentName, propName, definitionObject, finalInfo, implicitKeys, ComponentClass, stringInterningTable)
		} else {
			throw new Error(
				`SchemaParser: Invalid schema definition for ${componentName}.${propName}. ` +
					`Use a string type (e.g., 'f64') or a definition object (e.g., { type: 'f64' }).`
			)
		}
	}

	/**
	 * Parses a simple property definition (e.g., `{ x: 'f64' }`).
	 * @param {string} componentName - The name of the component class.
	 * @param {string} propName - The name of the property.
	 * @param {string} typeString - The string defining the property's type (e.g., 'f64').
	 * @param {object} finalInfo - The component info object to populate.
	 * @private
	 */
	_parseSimpleProperty(componentName, propName, typeString, finalInfo) {
		const arrayConstructor = this._getTypedArrayConstructor(typeString)
		if (!arrayConstructor) {
			throw new Error(`SchemaParser: Invalid type '${typeString}' in schema for ${componentName}.${propName}.`)
		}
		finalInfo.properties[propName] = { type: typeString, arrayConstructor }
		finalInfo.propertyKeys.push(propName)
	}

	/**
	 * Parses a complex property definition (e.g., `{ value: { type: 'string', ... } }`).
	 * This delegates to more specific parsers for different representation types.
	 * @param {string} componentName - The name of the component class.
	 * @param {string} propName - The name of the property.
	 * @param {object} propDefinition - The object defining the property's representation.
	 * @param {object} finalInfo - The component info object to populate.
	 * @param {string[]} implicitKeys - An array to collect implicitly created keys.
	 * @private
	 */_parseComplexProperty(componentName, propName, propDefinition, finalInfo, implicitKeys, ComponentClass, stringInterningTable) {
		finalInfo.representations[propName] = { ...propDefinition, originalKey: propName }

		switch (propDefinition.type) {
			case 'string':
				// Check for the 'capacity' or 'length' property to differentiate between interned and fixed-capacity strings.
				if (propDefinition.capacity || propDefinition.length) {
					this._parseFixedString(componentName, propName, propDefinition, finalInfo)
				} else {
					// This is the default for interned strings.
					this._parsePerEntityString(propName, finalInfo)
				}
				break
			case 'array':
				this._parseFlattenedArray(componentName, propName, propDefinition, finalInfo, implicitKeys)
				break
			case 'bitmask':
				this._parseBitmask(componentName, propName, propDefinition, finalInfo, ComponentClass)
				break
			case 'enum':
				this._parseEnum(componentName, propName, propDefinition, finalInfo, ComponentClass)
				break
			default:
				// Check if the type is a primitive like 'f64', 'u8', etc.
				const arrayConstructor = this._getTypedArrayConstructor(propDefinition.type)
				if (arrayConstructor) {
					// It's a primitive type.
					finalInfo.properties[propName] = { type: propDefinition.type, arrayConstructor }
					finalInfo.propertyKeys.push(propName)
				} else {
					throw new Error(
						`SchemaParser: Invalid object definition type '${propDefinition.type}' for ${componentName}.${propName}.`
					)
				}
		}
	}

	/**
	 * Parses a per-entity string representation, expanding it to `_offset` and `_length` properties for the SoA layout.
	 * @param {string} propName - The name of the shared string property.
	 * @param {object} finalInfo - The component info object to populate.
	 * @private
	 */
	_parsePerEntityString(propName, finalInfo) {
		const offsetKey = `${propName}_offset`
		const lengthKey = `${propName}_length`
		finalInfo.properties[offsetKey] = { type: 'u32', arrayConstructor: Uint32Array }
		finalInfo.properties[lengthKey] = { type: 'u32', arrayConstructor: Uint32Array }
		finalInfo.propertyKeys.push(offsetKey, lengthKey)
	}

	/**
	 * Parses a fixed-capacity string representation, expanding it to N `u8` properties.
	 * @param {string} componentName - The name of the component class.
	 * @param {string} propName - The name of the fixed string property.
	 * @param {object} propDefinition - The schema definition for the fixed string.
	 * @param {object} finalInfo - The component info object to populate.
	 * @private
	 */
	_parseFixedString(componentName, propName, propDefinition, finalInfo) {
		const capacity = propDefinition.capacity ?? propDefinition.length
		if (typeof capacity !== 'number' || capacity <= 0 || !Number.isInteger(capacity)) {
			throw new Error(
				`SchemaParser: Invalid 'capacity' or 'length' for fixed-string ${componentName}.${propName}. Must be a positive integer.`
			)
		}

		// Ensure the representation has a 'capacity' property for the view.
		finalInfo.representations[propName].capacity = capacity

		// A fixed string is stored as a sequence of bytes (u8).
		const arrayConstructor = Uint8Array
		for (let i = 0; i < capacity; i++) {
			const key = `${propName}${i}`
			finalInfo.properties[key] = { type: 'u8', arrayConstructor }
			finalInfo.propertyKeys.push(key)
		}
	}

	/**
	 * Parses a bitmask representation, creating a single integer property and a representation
	 * object containing a map of flag names to their bit values.
	 * @param {string} componentName - The name of the component class.
	 * @param {string} propName - The name of the bitmask property (e.g., 'flags').
	 * @param {object} propDefinition - The schema definition for the bitmask.
	 * @param {object} finalInfo - The component info object to populate.
	 * @param {Function} ComponentClass - The component class, to attach the generated flags enum.
	 * @private
	 */
	_parseBitmask(componentName, propName, { of, values }, finalInfo, ComponentClass) {
		const arrayConstructor = this._getTypedArrayConstructor(of)
		if (!arrayConstructor) {
			throw new Error(`SchemaParser: Invalid 'of' type '${of}' in bitmask for ${componentName}.${propName}.`)
		}
		if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) {
			throw new Error(`SchemaParser: 'values' for bitmask ${componentName}.${propName} must be an array of strings.`)
		}
		const maxFlags = arrayConstructor.BYTES_PER_ELEMENT * 8
		if (values.length > maxFlags) {
			throw new Error(
				`SchemaParser: Too many values for bitmask ${componentName}.${propName}. Type '${of}' supports ${maxFlags} flags, but ${values.length} were provided.`
			)
		}

		// This property becomes a single integer in the SoA layout.
		finalInfo.properties[propName] = { type: of, arrayConstructor }
		finalInfo.propertyKeys.push(propName)

		// Generate the flag map for the view and for static access.
		const flagMap = {}
		for (let i = 0; i < values.length; i++) {
			flagMap[values[i]] = 1 << i
		}

		// Store the representation info for the view factory.
		finalInfo.representations[propName] = { type: 'bitmask', originalKey: propName, flagMap: flagMap }

		// Attach the generated flags to the component class for easy access in constructors.
		ComponentClass[propName.toUpperCase()] = Object.freeze(flagMap)
	}

	/**
	 * Parses an enum representation, creating a single integer property and a representation
	 * object containing maps for value-to-name and name-to-value lookups.
	 * @param {string} componentName - The name of the component class.
	 * @param {string} propName - The name of the enum property (e.g., 'on').
	 * @param {object} propDefinition - The schema definition for the enum.
	 * @param {object} finalInfo - The component info object to populate.
	 * @param {Function} ComponentClass - The component class, to attach the generated enum map.
	 * @private
	 */
	_parseEnum(componentName, propName, { of, values }, finalInfo, ComponentClass) {
		const arrayConstructor = this._getTypedArrayConstructor(of)
		if (!arrayConstructor) {
			throw new Error(`SchemaParser: Invalid 'of' type '${of}' in enum for ${componentName}.${propName}.`)
		}
		if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) {
			throw new Error(`SchemaParser: 'values' for enum ${componentName}.${propName} must be an array of strings.`)
		}
		const maxValue = (1 << (arrayConstructor.BYTES_PER_ELEMENT * 8)) - 1
		if (values.length > maxValue + 1) {
			throw new Error(
				`SchemaParser: Too many values for enum ${componentName}.${propName}. Type '${of}' supports ${maxValue + 1} values, but ${values.length} were provided.`
			)
		}

		// This property becomes a single integer in the SoA layout.
		finalInfo.properties[propName] = { type: of, arrayConstructor }
		finalInfo.propertyKeys.push(propName)

		// Generate the enum map for the view and for static access.
		const enumMap = {}
		const valueMap = [] // For reverse lookup in the view
		for (let i = 0; i < values.length; i++) {
			const valueName = values[i]
			enumMap[valueName] = i
			valueMap[i] = valueName
		}

		finalInfo.representations[propName] = { type: 'enum', originalKey: propName, enumMap, valueMap }
		ComponentClass[propName.toUpperCase()] = Object.freeze(enumMap)
	}

	/**
	 * Parses a flattened array representation, expanding it to multiple properties and adding a `_count` property.
	 * @param {string} componentName - The name of the component class.
	 * @param {string} propName - The name of the array property.
	 * @param {object} propDefinition - The schema definition for the array.
	 * @param {object} finalInfo - The component info object to populate.
	 * @param {string[]} implicitKeys - An array to collect implicitly created keys.
	 * @private
	 */
	_parseFlattenedArray(componentName, propName, propDefinition, finalInfo, implicitKeys) {
		const { of, lengthProperty: userDefinedLengthProp } = propDefinition
		const capacity = propDefinition.capacity ?? propDefinition.length

		const lengthProperty = userDefinedLengthProp || `${propName}_count`
		finalInfo.representations[propName].lengthProperty = lengthProperty
		// Also ensure capacity is in the representation for the view
		finalInfo.representations[propName].capacity = capacity

		const arrayConstructor = this._getTypedArrayConstructor(of)
		if (!arrayConstructor) {
			throw new Error(`SchemaParser: Invalid 'of' type '${of}' in Array representation for ${componentName}.${propName}.`)
		}

		if (typeof capacity !== 'number' || capacity <= 0 || !Number.isInteger(capacity)) {
			throw new Error(`SchemaParser: Invalid 'capacity' or 'length' for array ${componentName}.${propName}. Must be a positive integer.`)
		}

		for (let propIndex = 0; propIndex < capacity; propIndex++) {
			const key = `${propName}${propIndex}`
			finalInfo.properties[key] = { type: of, arrayConstructor }
			finalInfo.propertyKeys.push(key)
		}

		// Add the backing property for the array's length if it's not explicitly defined in the schema.
		if (finalInfo.originalSchemaKeys.indexOf(lengthProperty) === -1) {
			const lenPropType = 'u8' // A 'u8' is a sensible default for counts up to 255.
			const lenArrayConstructor = this._getTypedArrayConstructor(lenPropType)
			finalInfo.properties[lengthProperty] = { type: lenPropType, arrayConstructor: lenArrayConstructor }
			finalInfo.propertyKeys.push(lengthProperty)
			implicitKeys.push(lengthProperty)
		}
	}

	/**
	 * A private helper to determine if a schemaless component is a "Tag" or "Cold"
	 * component by inspecting an instance. It also warns if a Cold component looks
	 * like it should be Hot.
	 * @param {Function} ComponentClass - The component class to check.
	 * @param {object} finalInfo - The component info object to populate.
	 * @private
	 */
	_detectStorageTypeForSchemaless(ComponentClass, finalInfo) {
		try {
			const tempInstance = new ComponentClass()
			const instanceKeys = Object.keys(tempInstance)

			if (instanceKeys.length === 0) {
				// No schema and no instance properties -> Tag component.
				// Tags are a form of "Hot" component (no data, just presence).
				finalInfo.storage = 'Hot'
				return
			}

			// Has instance properties -> Cold component.
			finalInfo.storage = 'Cold'

			// Heuristic to warn if it looks like it should have a schema.
			const propValues = Object.values(tempInstance)
			const isHotCandidate = propValues.every(val => val !== null && val !== undefined && typeof val !== 'object')

			if (isHotCandidate) {
				console.warn(
					`SchemaParser: Component '${ComponentClass.name}' has no schema and appears to only contain primitive values. ` +
						`For performance, consider defining a 'static schema' to make it a 'hot' component.`
				)
			}
		} catch (e) {
			// If constructor fails, assume it's a complex cold component.
			finalInfo.storage = 'Cold'
			// Silently ignore errors from constructor, as it's just a heuristic.
		}
	}

	_getTypedArrayConstructor(type) {
		switch (type) {
			// Aliases
			case 'bool':
			case 'boolean':
				return Uint8Array
			case 'float':
				return Float64Array
			case 'int':
			case 'integer':
				return Int32Array
			case 'unsigned':
			case 'uint':
				return Uint32Array

			// Explicit types
			case 'f64':
				return Float64Array
			case 'f32':
				return Float32Array
			case 'i32':
				return Int32Array
			case 'u32':
				return Uint32Array
			case 'i16':
				return Int16Array
			case 'u16':
				return Uint16Array
			case 'i8':
				return Int8Array
			case 'u8':
				return Uint8Array
			default:
				return null
		}
	}
}