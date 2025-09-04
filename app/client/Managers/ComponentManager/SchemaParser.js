/**
 * @fileoverview Parses component schemas into a structured format for the engine.
 * This class is responsible for interpreting the `static schema` property of components
 * and converting it into a detailed component info object that the ArchetypeManager
 * can use to lay out data in memory efficiently.
 *
 * ### Developer Note: Designing Component Schemas
 *
 * The `static schema` is the key to the engine's performance. It dictates how a
 * component's data is stored and accessed. Choosing the right schema type is crucial.
 *
 * #### 1. Primitive Types
 * For simple numeric properties. This is the most common and performant type.
 * - **Explicit:** `{ type: 'f64' }`
 * - **Shorthand:** `'f64'`
 * - **Supported Types:** `f64`, `f32`, `i32`, `u32`, `i16`, `u16`, `i8`, `u8`, `boolean`
 *
 * #### 2. Interned Strings
 * For string data that is likely to be repeated across many entities (e.g., names, IDs).
 * The engine stores a single copy of the string and uses an integer reference.
 * - **Shorthand:** `'string'`
 * - **Explicit:** `{ type: 'string' }`
 *
 * #### 3. Enums
 * For a property that can only be one of a set of mutually exclusive string values.
 * The underlying storage type (`u8`, `u16`, `u32`) is inferred automatically based on the number of options.
 * - **Shorthand:** `{ type: 'enum', of: ['STATE_A', 'STATE_B', 'STATE_C'] }`
 *
 * #### 4. Bitmasks
 * For properties that can have multiple states simultaneously (e.g., status effects).
 * The underlying storage type is also inferred automatically.
 * - **Shorthand:** `{ type: 'bitmask', of: ['FLAG_A', 'FLAG_B', 'FLAG_C'] }`
 *
 * #### 5. Array Types
 * - **`flat_array`**: For fixed-size collections of simple data. Wastes memory if arrays are not full.
 *   - `{ type: 'flat_array', of: 'u32', capacity: 10 }`
 * - **`pack_array`**: For variable-size collections. More memory efficient, slightly more complex.
 *   - `{ type: 'pack_array', of: 'u32' }`
 *
 */

export class SchemaParser {
	/**
	 * Parses a component's schema and stores the structured information.
	 * @param {Function} ComponentClass - The component class.
	 * @param {number} typeID - The component's type ID.
	 * @returns {Promise<object>} The parsed component information object.
	 */
	async parse(ComponentClass, typeID) {
		/**
		 * @typedef {object} ComponentInfo
		 * @property {number} typeID - The unique ID of the component.
		 * @property {string[]} propertyKeys - The final, expanded list of property keys for the SoA layout.
		 * @property {Object.<string, object>} representations - Maps original schema keys to their representation info.
		 * @property {string[]} originalSchemaKeys - The original keys from the component's schema definition.
		 * @property {Object.<string, {type: string, arrayConstructor: Function}>} properties - Maps final property keys to their type and TypedArray constructor.
		 * @property {Object.<string, object>} [packedArrays] - Metadata for any packed arrays in this component.
		 */

		/** @type {ComponentInfo} */
		const componentInfo = {
			typeID,
			propertyKeys: [],
			representations: {},
			originalSchemaKeys: [],
			properties: {},
            byteSize: 0,
			sharedProperties: [],
			perEntityProperties: [],
		}

		const schema = ComponentClass.schema

		if (schema === undefined || Object.keys(schema).length === 0) {
			// This is a "tag" component (e.g., `static schema = {}` or no schema defined), which is valid.
			return componentInfo
		}

		//  Parse properties
		const schemaKeys = Object.keys(schema).sort()
		componentInfo.originalSchemaKeys = [...schemaKeys]
		const implicitKeys = []
		for (const propName of schemaKeys) {
			const propDefinition = schema[propName]
			this.parseProperty(propName, propDefinition, componentInfo, implicitKeys, ComponentClass)
		}

		// Add any implicitly created keys (like 'count') to the list of schema keys
		// so they are available on component views, then sort for determinism.
		componentInfo.originalSchemaKeys.push(...implicitKeys)
		componentInfo.originalSchemaKeys.sort()

		// Sort final property keys for deterministic array layout and to remove duplicates
		componentInfo.propertyKeys = [...new Set(componentInfo.propertyKeys)].sort()

		// Separate properties into shared and per-entity lists
		for (const propName of componentInfo.originalSchemaKeys) {
			if (componentInfo.representations[propName]?.shared) {
				componentInfo.sharedProperties.push(propName)
			} else {
				componentInfo.perEntityProperties.push(propName)
			}
		}

		// If there are any shared properties, add the groupId to the component's storage schema.
		// This is the core of the "Shared Components as Indirect References" pattern.
		if (componentInfo.sharedProperties.length > 0) {
			const groupIdPropName = 'groupId'
			if (!componentInfo.properties[groupIdPropName]) {
				const arrayConstructor = this.getTypedArrayConstructor('u32')
				componentInfo.properties[groupIdPropName] = { type: 'u32', arrayConstructor }
				componentInfo.propertyKeys.push(groupIdPropName)
				componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT
			}
		}

		return componentInfo
	}

	/**
	 * Parses a single property from a component schema, handling shorthands and dispatching to the correct parser.
	 * @param {string} propName - The name of the property being parsed.
	 * @param {string|object} propDefinition - The schema definition for the property.
	 * @param {object} componentInfo - The component info object being built.
	 * @param {string[]} implicitKeys - An array to collect keys created implicitly (e.g., `slots_count`).
	 * @param {Function} ComponentClass - The component class itself.
	 */
	parseProperty(propName, propDefinition, componentInfo, implicitKeys, ComponentClass) {
		let definitionObject = propDefinition

		if (typeof propDefinition === 'string') {
			definitionObject = { type: propDefinition }
		}

		// This is the new central point for schema normalization.
		// It ensures that by the end of this block, the definitionObject has an explicit
		// .type for the rest of the system to use.
		if (typeof definitionObject === 'object') {
			const type = definitionObject.type
			switch (type) {
				case 'string':
					// Strings are always backed by a u32 for the interned ID.
					definitionObject.storageType = 'u32'
					break
				case 'enum':
					// Infer the backing type and overwrite .type
					if (definitionObject.of.length <= 256) {
						definitionObject.storageType = 'u8'
					} else if (definitionObject.of.length <= 65536) {
						definitionObject.storageType = 'u16'
					} else {
						definitionObject.storageType = 'u32'
					}
					break
				case 'bitmask':
					// Infer the backing type and overwrite .type
					if (definitionObject.of.length <= 8) {
						definitionObject.storageType = 'u8'
					} else if (definitionObject.of.length <= 16) {
						definitionObject.storageType = 'u16'
					} else if (definitionObject.of.length <= 32) {
						definitionObject.storageType = 'u32'
					} else {
						throw new Error(
							`SchemaParser: Bitmask for ${ComponentClass.name}.${propName} has too many values (${definitionObject.of.length}). Maximum supported is 32.`
						)
					}
					break
			}
		}

		if (typeof definitionObject !== 'object' || !definitionObject.type) {
			throw new Error(
				`SchemaParser: Invalid schema definition for ${ComponentClass.name}.${propName}. ` +
					`Could not determine a valid type.`
			)
		}

		componentInfo.representations[propName] = { ...definitionObject, originalKey: propName }
		const type = definitionObject.type
		const parserMethod = this[type]

		if (typeof parserMethod === 'function') {
			parserMethod.call(this, propName, definitionObject, componentInfo, implicitKeys, ComponentClass)
		} else {
			// This is a primitive property with no special parser (e.g., { type: 'f64' }).
			const arrayConstructor = this.getTypedArrayConstructor(definitionObject.type)
			if (arrayConstructor) {
				// It's a primitive type.
				// If it's a shared property, we don't add its own data to the SoA layout.
				// The 'groupId' property will be added later at the end of the parse() method.
				if (definitionObject.shared) {
					return
				}

				componentInfo.properties[propName] = { type: definitionObject.type, arrayConstructor }
				componentInfo.propertyKeys.push(propName)
                componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT;
			} else {
				throw new Error(
					`SchemaParser: Invalid type '${definitionObject.type}' for ${ComponentClass.name}.${propName}.`
				)
			}
		}
	}

	/**
	 * Parses an interned string representation.
	 */
	string(propName, propDefinition, componentInfo, implicitKeys, ComponentClass) {
		// If it's a shared property, we don't add its own data to the SoA layout.
		// The 'groupId' property will be added later.
		if (propDefinition.shared) {
			return
		}
		componentInfo.properties[propName] = { type: 'u32', arrayConstructor: Uint32Array }
		componentInfo.propertyKeys.push(propName)
		componentInfo.byteSize += Uint32Array.BYTES_PER_ELEMENT;
	}

	/**
	 * Parses a bitmask representation.
	 */
	bitmask(propName, propDefinition, componentInfo, implicitKeys, ComponentClass) {
		if (propDefinition.shared) {
			throw new Error(`SchemaParser: The 'shared' flag is not supported for bitmask properties like '${ComponentClass.name}.${propName}'.`)
		}
		const { storageType, of: values } = propDefinition
		const arrayConstructor = this.getTypedArrayConstructor(storageType)
		if (!arrayConstructor) {
			throw new Error(`SchemaParser: Invalid 'storageType' '${storageType}' in bitmask for ${ComponentClass.name}.${propName}.`)
		}
		if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) {
			throw new Error(`SchemaParser: 'of' for bitmask ${ComponentClass.name}.${propName} must be an array of strings.`)
		}
		const maxFlags = arrayConstructor.BYTES_PER_ELEMENT * 8
		if (values.length > maxFlags) {
			throw new Error(
				`SchemaParser: Too many values for bitmask ${ComponentClass.name}.${propName}. Type '${storageType}' supports ${maxFlags} flags, but ${values.length} were provided.`
			)
		}

		componentInfo.properties[propName] = { type: storageType, arrayConstructor }
		componentInfo.propertyKeys.push(propName)
		componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT;

		const flagMap = {}
		for (let i = 0; i < values.length; i++) {
			flagMap[values[i]] = 1 << i
		}

		componentInfo.representations[propName] = { type: 'bitmask', originalKey: propName, flagMap: flagMap, values: values }

		ComponentClass[propName.toUpperCase()] = Object.freeze(flagMap)
	}

	/**
	 * Parses an enum representation.
	 */
	enum(propName, propDefinition, componentInfo, implicitKeys, ComponentClass) {
		const { storageType, of: values } = propDefinition
		const arrayConstructor = this.getTypedArrayConstructor(storageType)
		if (!arrayConstructor) {
			throw new Error(`SchemaParser: Invalid 'storageType' '${storageType}' in enum for ${ComponentClass.name}.${propName}.`)
		}
		if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) {
			throw new Error(`SchemaParser: 'of' for enum ${ComponentClass.name}.${propName} must be an array of strings.`)
		}
		const maxValue = (1 << (arrayConstructor.BYTES_PER_ELEMENT * 8)) - 1
		if (values.length > maxValue + 1) {
			throw new Error(
				`SchemaParser: Too many values for enum ${ComponentClass.name}.${propName}. Type '${storageType}' supports ${
					maxValue + 1
				} values, but ${values.length} were provided.`
			)
		}

		const enumMap = {}
		const valueMap = []
		for (let i = 0; i < values.length; i++) {
			const valueName = values[i]
			enumMap[valueName] = i
			valueMap[i] = valueName
		}

		componentInfo.representations[propName] = { type: 'enum', originalKey: propName, enumMap, valueMap, values: values }
		ComponentClass[propName.toUpperCase()] = Object.freeze(enumMap)

		// If it's a shared property, we don't add its own data to the SoA layout.
		// The 'groupId' property will be added later.
		if (propDefinition.shared) return

		componentInfo.properties[propName] = { type: storageType, arrayConstructor }
		componentInfo.propertyKeys.push(propName)
		componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT;
	}

	/**
	 * Parses a packed array representation.
	 */
	pack_array(propName, propDefinition, componentInfo, implicitKeys, ComponentClass) {
		if (propDefinition.shared) {
			throw new Error(`SchemaParser: The 'shared' flag is not supported for complex types like 'pack_array' in '${ComponentClass.name}.${propName}'.`)
		}
		const { of } = propDefinition

		if (!of) {
			throw new Error(`SchemaParser: pack_array schema for ${ComponentClass.name}.${propName} must have an 'of' property.`)
		}

		let itemSchema = of
		if (typeof itemSchema === 'string') {
			itemSchema = { type: itemSchema }
		}

		// For now, packed arrays will only support primitive types.
		// Complex types like enums in packed arrays can be added later if needed.
		const itemStorageType = itemSchema.type
		const itemArrayConstructor = this.getTypedArrayConstructor(itemStorageType)

		if (!itemArrayConstructor) {
			throw new Error(
				`SchemaParser: Invalid 'of' type '${itemStorageType}' in pack_array for ${ComponentClass.name}.${propName}.`
			)
		}

		if (!componentInfo.packedArrays) {
			componentInfo.packedArrays = {}
		}

		// Store metadata for the Archetype/Chunk to use
		componentInfo.packedArrays[propName] = {
			originalKey: propName,
			itemType: itemStorageType,
			itemSize: itemArrayConstructor.BYTES_PER_ELEMENT,
			itemConstructor: itemArrayConstructor,
		}

		// Define the representation for the array property itself.
		if (!componentInfo.representations[propName]) {
			componentInfo.representations[propName] = { ...propDefinition, originalKey: propName }
		}
		componentInfo.representations[propName].startIndexProperty = `${propName}_startIndex`
		componentInfo.representations[propName].lengthProperty = `${propName}_length`

		// Create the startIndex property
		const startIndexProperty = `${propName}_startIndex`
		const startIndexConstructor = this.getTypedArrayConstructor('u32')
		componentInfo.properties[startIndexProperty] = { type: 'u32', arrayConstructor: startIndexConstructor }
		componentInfo.propertyKeys.push(startIndexProperty)
		implicitKeys.push(startIndexProperty)
		componentInfo.byteSize += startIndexConstructor.BYTES_PER_ELEMENT;

		// Create the length property
		const lengthProperty = `${propName}_length`
		const lengthConstructor = this.getTypedArrayConstructor('u16')
		componentInfo.properties[lengthProperty] = { type: 'u16', arrayConstructor: lengthConstructor }
		componentInfo.propertyKeys.push(lengthProperty)
		implicitKeys.push(lengthProperty)
		componentInfo.byteSize += lengthConstructor.BYTES_PER_ELEMENT;
	}

	/**
	 * Parses a flattened array representation.
	 * Handles arrays of primitives (e.g., { of: 'u32' }) and arrays of complex types (e.g., { of: { type: 'enum', ... } }).
	 */
	flat_array(propName, propDefinition, componentInfo, implicitKeys, ComponentClass) {
		if (propDefinition.shared) {
			throw new Error(`SchemaParser: The 'shared' flag is not supported for complex types like 'flat_array' in '${ComponentClass.name}.${propName}'.`)
		}
		const { of, capacity, lengthProperty: userDefinedLengthProp } = propDefinition
		const len = capacity ?? propDefinition.length

		if (!of) {
			throw new Error(`SchemaParser: flat_array schema for ${ComponentClass.name}.${propName} must have an 'of' property.`)
		}
		if (typeof len !== 'number' || len <= 0 || !Number.isInteger(len)) {
			throw new Error(`SchemaParser: Invalid 'capacity' or 'length' for flat_array ${ComponentClass.name}.${propName}. Must be a positive integer.`)
		}

		let itemSchema = of
		if (typeof itemSchema === 'string') {
			itemSchema = { type: itemSchema }
		}

		let itemStorageType
		let itemRepresentation = { ...itemSchema }

		// Determine the underlying storage type for the array items
		switch (itemSchema.type) {
			case 'string':
				itemStorageType = 'u32' // Interned strings are stored as u32 refs
				break
			case 'enum':
				if (!Array.isArray(itemSchema.of) || itemSchema.of.some(v => typeof v !== 'string'))
					throw new Error(`SchemaParser: 'of' for enum in flat_array ${ComponentClass.name}.${propName} must be an array of strings.`)
				if (itemSchema.of.length <= 256) {
					itemStorageType = 'u8'
				} else if (itemSchema.of.length <= 65536) {
					itemStorageType = 'u16'
				} else {
					itemStorageType = 'u32'
				}
				const enumMap = {}
				const valueMap = []
				for (let i = 0; i < itemSchema.of.length; i++) {
					const valueName = itemSchema.of[i]
					enumMap[valueName] = i
					valueMap[i] = valueName
				}
				itemRepresentation.enumMap = enumMap
				itemRepresentation.valueMap = valueMap
				break
			// NOTE: Could add 'bitmask' or other complex types here in the future
			default:
				// This handles primitive types like 'u32', 'f64', etc.
				itemStorageType = itemSchema.type
				break
		}

		const arrayConstructor = this.getTypedArrayConstructor(itemStorageType)
		if (!arrayConstructor) {
			throw new Error(
				`SchemaParser: Invalid 'of' type '${itemStorageType}' in flat_array for ${ComponentClass.name}.${propName}.`
			)
		}

		// Define the representation for the array property itself.
		if (!componentInfo.representations[propName]) {
			componentInfo.representations[propName] = { ...propDefinition, originalKey: propName }
		}
		// This is the crucial part for the ComponentProcessor. It tells it how to handle individual items.
		componentInfo.representations[propName].itemRepresentation = itemRepresentation
		componentInfo.representations[propName].capacity = len

		// Define the length property (e.g., 'myArray_count')
		const lengthProperty = userDefinedLengthProp || `${propName}_count`
		componentInfo.representations[propName].lengthProperty = lengthProperty
		if (componentInfo.originalSchemaKeys.indexOf(lengthProperty) === -1) {
			const lenPropType = 'u8'
			const lenArrayConstructor = this.getTypedArrayConstructor(lenPropType)
			componentInfo.properties[lengthProperty] = { type: lenPropType, arrayConstructor: lenArrayConstructor }
			componentInfo.propertyKeys.push(lengthProperty)
		implicitKeys.push(lengthProperty)
			componentInfo.byteSize += lenArrayConstructor.BYTES_PER_ELEMENT;
		}

		// Create the flattened properties for the array storage (e.g., 'myArray0', 'myArray1', ...)
		for (let propIndex = 0; propIndex < len; propIndex++) {
			const key = `${propName}${propIndex}`
			componentInfo.properties[key] = { type: itemStorageType, arrayConstructor }
			componentInfo.propertyKeys.push(key)
			componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT;
		}
	}

	/**
	 * Parses a Reverse Polish Notation (RPN) formula representation.
	 */
	rpn(propName, propDefinition, componentInfo, implicitKeys, ComponentClass) {
		if (propDefinition.shared) {
			throw new Error(`SchemaParser: The 'shared' flag is not supported for complex types like 'rpn' in '${ComponentClass.name}.${propName}'.`)
		}
		// The `type` of the stream is defined by `streamDataType`, defaulting to 'f32'.
		// This avoids collision with `propDefinition.type`, which is 'rpn'.
		const { streamDataType = 'f32', streamCapacity, instanceCapacity } = propDefinition

		if (typeof streamCapacity !== 'number' || streamCapacity <= 0 || !Number.isInteger(streamCapacity)) {
			throw new Error(
				`SchemaParser: Invalid 'streamCapacity' for rpn ${ComponentClass.name}.${propName}. Must be a positive integer.`
			)
		}
		if (typeof instanceCapacity !== 'number' || instanceCapacity <= 0 || !Number.isInteger(instanceCapacity)) {
			throw new Error(
				`SchemaParser: Invalid 'instanceCapacity' for rpn ${ComponentClass.name}.${propName}. Must be a positive integer.`
			)
		}

		componentInfo.representations[propName] = {
			...propDefinition,
			originalKey: propName,
			streamProperty: `${propName}_rpnStream`,
			startsProperty: `${propName}_formulaStarts`,
			lengthsProperty: `${propName}_formulaLengths`,
			streamCapacity, // Pass capacities to the processor
			instanceCapacity,
		}

		this.flat_array(
			`${propName}_rpnStream`,
			{ of: streamDataType, capacity: streamCapacity },
			componentInfo,
			implicitKeys,
			ComponentClass
		)
		// Add the stream's length property to the representation for the processor to use
		componentInfo.representations[propName].streamLengthProperty = `${propName}_rpnStream_count`

		this.flat_array(
			`${propName}_formulaStarts`,
			{ of: 'i16', capacity: instanceCapacity },
			componentInfo,
			implicitKeys,
			ComponentClass
		)
		this.flat_array(
			`${propName}_formulaLengths`,
			{ of: 'u8', capacity: instanceCapacity },
			componentInfo,
			implicitKeys,
			ComponentClass
		)
	}

	getTypedArrayConstructor(type) {
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