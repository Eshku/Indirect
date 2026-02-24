import { TYPED_ARRAY_MAP } from './ComponentSchema.js'
const { interpret } = await import('./ComponentInterpreter.js')

const getTypedArrayConstructor = type => TYPED_ARRAY_MAP[type] || null

/**
 * A registry of processors for different schema property types.
 * Each processor is responsible for parsing its type definition, calculating memory layout,
 * and compiling default values.
 */
const TypeProcessors = {
	// This will be populated below to avoid reference errors during initialization.
}

// First, create all the primitive type processors.
const PrimitiveTypeProcessors = Object.keys(TYPED_ARRAY_MAP).reduce((processors, type) => {
	processors[type] = {
		parse(propName, definition, componentInfo) {
			const arrayConstructor = getTypedArrayConstructor(definition.type)
			const readMethod = `get${arrayConstructor.name.replace('Array', '')}`

			// Align the current offset to the requirement of this property.
			const alignment = arrayConstructor.BYTES_PER_ELEMENT
			if (alignment > 0 && componentInfo.byteSize % alignment !== 0) {
				componentInfo.byteSize += alignment - (componentInfo.byteSize % alignment)
			}
			const offset = componentInfo.byteSize

			componentInfo.properties[propName] = {
				type: definition.type,
				alignment,
				arrayConstructor,
				readMethod,
				offset,
			}

			if (definition.shared) {
				// A shared property does not get its own storage in the chunk.
				// We have recorded its info in `properties`, so now we can return.
				return
			}

			componentInfo.propertyKeys.push(propName)
			componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT
		},
	}
	return processors
}, {})

// Now, assign all processors to the main TypeProcessors object.
Object.assign(TypeProcessors, {
	...PrimitiveTypeProcessors,
	string: {
		parse: PrimitiveTypeProcessors.u32.parse, // A string is stored as a u32.
	},
	bitmask: {
		/**
		 * DEV-NOTE: A `bitmask` is stored as a single integer (the "bitfield").
		 * The `default` value for a bitmask must be a number, which is a bitwise combination
		 * of the values in the `of` object.
		 */ parse(propName, definition, componentInfo, implicitKeys, componentName, constants) {
			if (definition.shared) {
				throw new Error(
					`SchemaCompiler: The 'shared' flag is not supported for bitmask properties like '${componentName}.${propName}'.`,
				)
			}
			const { storageType, of: flagMap } = definition
			const arrayConstructor = getTypedArrayConstructor(storageType)

			if (typeof flagMap !== 'object' || flagMap === null || Array.isArray(flagMap)) {
				throw new Error(
					`SchemaCompiler: 'of' for bitmask ${componentName}.${propName} must be an object map of flags to integer values.`,
				)
			}

			const readMethod = `get${arrayConstructor.name.replace('Array', '')}`

			// Align the current offset to the requirement of this property.
			const alignment = arrayConstructor.BYTES_PER_ELEMENT
			if (alignment > 0 && componentInfo.byteSize % alignment !== 0) {
				componentInfo.byteSize += alignment - (componentInfo.byteSize % alignment)
			}
			const offset = componentInfo.byteSize

			componentInfo.properties[propName] = {
				type: storageType,
				alignment,
				arrayConstructor,
				readMethod,
				offset,
			}
			componentInfo.propertyKeys.push(propName)
			componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT

			componentInfo.representations[propName].flagMap = flagMap
			constants[propName.toUpperCase()] = Object.freeze(flagMap)
		},
	},
	enum: {
		/**
		 * DEV-NOTE (Low-Level): An `enum` is stored as a single integer representing the index of the
		 * string value in the `of` array. For a schema `{ myEnum: { type: 'enum', of: ['A', 'B', 'C'] } }`,
		 * the compiler creates a single property `myEnum` backed by a `Uint8Array` (or `u16`/`u32` for
		 * more options). In a chunk, this array will hold the raw integer indices (0 for 'A', 1 for 'B', etc.).
		 * This is highly memory-efficient, and the engine automatically handles the conversion to and from
		 * the string representation for you when using high-level APIs.
		 */
		parse(propName, definition, componentInfo, implicitKeys, componentName, constants) {
			const { storageType, of: enumMap } = definition
			const arrayConstructor = getTypedArrayConstructor(storageType)

			if (typeof enumMap !== 'object' || enumMap === null || Array.isArray(enumMap)) {
				throw new Error(
					`SchemaCompiler: 'of' for enum ${componentName}.${propName} must be an object map of names to integer values.`,
				)
			}
			const maxValue = (1 << (arrayConstructor.BYTES_PER_ELEMENT * 8)) - 1
			if (Object.keys(enumMap).length > maxValue + 1) {
				throw new Error(
					`SchemaCompiler: Too many values for enum ${componentName}.${propName}. Type '${storageType}' supports ${
						maxValue + 1
					} values, but ${Object.keys(enumMap).length} were provided.`,
				)
			}

			const valueMap = []
			for (const valueName in enumMap) {
				const integerValue = enumMap[valueName]
				valueMap[integerValue] = valueName
			}

			if (definition.shared) {
				componentInfo.representations[propName].enumMap = enumMap
				componentInfo.representations[propName].valueMap = valueMap
				constants[propName.toUpperCase()] = Object.freeze(enumMap)
				return
			}

			const readMethod = `get${arrayConstructor.name.replace('Array', '')}`

			// Align the current offset to the requirement of this property.
			const alignment = arrayConstructor.BYTES_PER_ELEMENT
			if (alignment > 0 && componentInfo.byteSize % alignment !== 0) {
				componentInfo.byteSize += alignment - (componentInfo.byteSize % alignment)
			}
			const offset = componentInfo.byteSize

			componentInfo.properties[propName] = {
				type: storageType,
				alignment,
				arrayConstructor,
				readMethod,
				offset,
			}
			componentInfo.propertyKeys.push(propName)
			componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT

			componentInfo.representations[propName].enumMap = enumMap
			componentInfo.representations[propName].valueMap = valueMap
			constants[propName.toUpperCase()] = Object.freeze(enumMap)
		},
	},
	dynamic_array: {
		parse(propName, definition, componentInfo, implicitKeys, componentName) {
			if (definition.shared) {
				throw new Error(
					`SchemaCompiler: The 'shared' flag is not supported for complex types like 'pack_array' in '${componentName}.${propName}'.`,
				)
			}
			const { of } = definition

			if (!of) {
				throw new Error(
					`SchemaCompiler: pack_array schema for ${componentName}.${propName} must have an 'of' property.`,
				)
			}

			let itemSchema = of
			if (typeof itemSchema === 'string') {
				itemSchema = { type: itemSchema }
			}

			const itemStorageType = itemSchema.type
			const itemArrayConstructor = getTypedArrayConstructor(itemStorageType)

			if (!itemArrayConstructor) {
				throw new Error(
					`SchemaCompiler: Invalid 'of' type '${itemStorageType}' in pack_array for ${componentName}.${propName}.`,
				)
			}

			if (!componentInfo.packedArrays) {
				componentInfo.packedArrays = {}
			}

			componentInfo.packedArrays[propName] = {
				originalKey: propName,
				itemType: itemStorageType,
				itemSize: itemArrayConstructor.BYTES_PER_ELEMENT,
				itemConstructor: itemArrayConstructor,
			}

			// Create the representation for the implicit properties before they are parsed.
			// This prevents errors if a handler were to be called directly.
			if (!componentInfo.representations[propName]) {
				componentInfo.representations[propName] = { ...definition, originalKey: propName }
			}

			componentInfo.representations[propName].startIndexProperty = `${propName}_startIndex`
			componentInfo.representations[propName].lengthProperty = `${propName}_length`

			const startIndexProperty = `${propName}_startIndex`
			const startIndexConstructor = getTypedArrayConstructor('u32')
			componentInfo.properties[startIndexProperty] = {
				type: 'u32',
				arrayConstructor: startIndexConstructor,
				readMethod: `get${startIndexConstructor.name.replace('Array', '')}`,
				offset: componentInfo.byteSize,
			}
			componentInfo.propertyKeys.push(startIndexProperty)
			implicitKeys.push(startIndexProperty)
			componentInfo.byteSize += startIndexConstructor.BYTES_PER_ELEMENT

			const lengthProperty = `${propName}_length`
			const lengthConstructor = getTypedArrayConstructor('u16')
			componentInfo.properties[lengthProperty] = {
				type: 'u16',
				arrayConstructor: lengthConstructor,
				readMethod: `get${lengthConstructor.name.replace('Array', '')}`,
				offset: componentInfo.byteSize,
			}
			componentInfo.propertyKeys.push(lengthProperty)
			implicitKeys.push(lengthProperty)
			componentInfo.byteSize += lengthConstructor.BYTES_PER_ELEMENT
		},
		// pack_array does not generate a program instruction; it's handled by ArchetypeManager.
	},
	flat_array: {
		/**
		 * DEV-NOTE: A `flat_array` is not stored as a nested array. Instead, it is "flattened"
		 * into the component's SoA layout. For a schema like `{ my_array: { type: 'flat_array', of: 'u32', capacity: 3 } }`,
		 * the compiler generates individual properties `my_array0`, `my_array1`, and `my_array2`, each with its
		 * own `Uint32Array` in the chunk.
		 * It also creates an implicit `my_array_count` property (a `u8`) to store the *current* length of the
		 * array for each entity, which can be less than the total capacity. This design keeps data access
		 * extremely fast and cache-friendly for fixed-size collections.
		 */ parse(propName, definition, componentInfo, implicitKeys, componentName, constants) {
			if (definition.shared) {
				throw new Error(
					`SchemaCompiler: The 'shared' flag is not supported for complex types like 'flat_array' in '${componentName}.${propName}'.`,
				)
			}
			const { of, capacity, lengthProperty: userDefinedLengthProp } = definition
			const len = capacity ?? definition.length

			if (!of) {
				throw new Error(
					`SchemaCompiler: flat_array schema for ${componentName}.${propName} must have an 'of' property.`,
				)
			}
			if (typeof len !== 'number' || len <= 0 || !Number.isInteger(len)) {
				throw new Error(
					`SchemaCompiler: Invalid 'capacity' or 'length' for flat_array ${componentName}.${propName}. Must be a positive integer.`,
				)
			}

			let itemSchema = of
			if (typeof itemSchema === 'string') {
				itemSchema = { type: itemSchema }
			}

			let itemStorageType
			// Start with the original schema, but we will overwrite the 'type' property.
			let itemRepresentation = { ...itemSchema }
			itemRepresentation.originalType = itemSchema.type // Preserve the high-level type

			switch (itemSchema.type) {
				case 'string':
					itemStorageType = 'u32'
					break
				case 'bitmask': {
					const flagMap = itemSchema.of
					if (typeof flagMap !== 'object' || flagMap === null || Array.isArray(flagMap)) {
						throw new Error(
							`SchemaCompiler: 'of' for bitmask in flat_array ${componentName}.${propName} must be an object map.`,
						)
					}
					// Auto-detect storage type if not provided, based on number of flags.
					if (itemSchema.storageType) {
						itemStorageType = itemSchema.storageType
					} else {
						const numFlags = Object.keys(flagMap).length
						if (numFlags <= 8) itemStorageType = 'u8'
						else if (numFlags <= 16) itemStorageType = 'u16'
						else itemStorageType = 'u32'
					}
					itemRepresentation.flagMap = flagMap
					constants[propName.toUpperCase()] = Object.freeze(flagMap)
					break
				}
				case 'enum':
					const enumMap = itemSchema.of
					if (typeof enumMap !== 'object' || enumMap === null || Array.isArray(enumMap)) {
						throw new Error(
							`SchemaCompiler: 'of' for enum in flat_array ${componentName}.${propName} must be an object map.`,
						)
					}

					const numValues = Object.keys(enumMap).length
					if (numValues <= 256) {
						itemStorageType = 'u8'
					} else if (numValues <= 65536) {
						itemStorageType = 'u16'
					} else {
						itemStorageType = 'u32'
					}

					const valueMap = []
					for (const valueName in enumMap) {
						valueMap[enumMap[valueName]] = valueName
					}
					itemRepresentation.enumMap = enumMap
					itemRepresentation.valueMap = valueMap
					constants[propName.toUpperCase()] = Object.freeze(enumMap)
					break
				default:
					itemStorageType = itemSchema.type
					break
			}

			itemRepresentation.type = itemStorageType

			const arrayConstructor = getTypedArrayConstructor(itemStorageType)
			if (!arrayConstructor) {
				throw new Error(
					`SchemaCompiler: Invalid 'of' type '${itemStorageType}' in flat_array for ${componentName}.${propName}.`,
				)
			}

			componentInfo.representations[propName].itemRepresentation = itemRepresentation
			componentInfo.representations[propName].capacity = len

			const lengthProperty = userDefinedLengthProp || `${propName}_count`
			componentInfo.representations[propName].lengthProperty = lengthProperty
			if (componentInfo.originalSchemaKeys.indexOf(lengthProperty) === -1) {
				const lenPropType = 'u8'
				const lenArrayConstructor = getTypedArrayConstructor(lenPropType)
				componentInfo.properties[lengthProperty] = {
					type: lenPropType,
					alignment: lenArrayConstructor.BYTES_PER_ELEMENT,
					arrayConstructor: lenArrayConstructor,
					readMethod: `get${lenArrayConstructor.name.replace('Array', '')}`,
					offset: componentInfo.byteSize, // This will be incorrect if not last, but it is.
				}
				componentInfo.propertyKeys.push(lengthProperty)
				implicitKeys.push(lengthProperty)
				componentInfo.byteSize += lenArrayConstructor.BYTES_PER_ELEMENT
			}

			for (let propIndex = 0; propIndex < len; propIndex++) {
				const key = `${propName}${propIndex}`
				const readMethod = `get${arrayConstructor.name.replace('Array', '')}`

				const alignment = arrayConstructor.BYTES_PER_ELEMENT
				if (alignment > 0 && componentInfo.byteSize % alignment !== 0) {
					componentInfo.byteSize += alignment - (componentInfo.byteSize % alignment)
				}
				const offset = componentInfo.byteSize

				componentInfo.properties[key] = { type: itemStorageType, arrayConstructor, readMethod, offset, alignment }
				componentInfo.propertyKeys.push(key)
				componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT
			}
		},
	},
	rpn: {
		parse(propName, definition, componentInfo, implicitKeys, componentName, constants) {
			if (definition.shared) {
				throw new Error(
					`SchemaCompiler: The 'shared' flag is not supported for complex types like 'rpn' in '${componentName}.${propName}'.`,
				)
			}
			const { streamDataType = 'f32', streamCapacity, instanceCapacity } = definition

			if (typeof streamCapacity !== 'number' || streamCapacity <= 0 || !Number.isInteger(streamCapacity)) {
				throw new Error(
					`SchemaCompiler: Invalid 'streamCapacity' for rpn ${componentName}.${propName}. Must be a positive integer.`,
				)
			}
			if (typeof instanceCapacity !== 'number' || instanceCapacity <= 0 || !Number.isInteger(instanceCapacity)) {
				throw new Error(
					`SchemaCompiler: Invalid 'instanceCapacity' for rpn ${componentName}.${propName}. Must be a positive integer.`,
				)
			}

			componentInfo.representations[propName] = {
				...definition,
				originalKey: propName,
				streamProperty: `${propName}_rpnStream`,
				startsProperty: `${propName}_formulaStarts`,
				lengthsProperty: `${propName}_formulaLengths`,
				streamCapacity,
				instanceCapacity,
			}

			// Create representations for the implicit properties before delegating to another handler.
			// This ensures the target handler finds the expected structure in componentInfo.
			const streamPropDef = { of: streamDataType, capacity: streamCapacity }
			componentInfo.representations[`${propName}_rpnStream`] = { type: 'flat_array', ...streamPropDef }
			componentInfo.representations[`${propName}_formulaStarts`] = {
				type: 'flat_array',
				of: 'i16',
				capacity: instanceCapacity,
			}
			componentInfo.representations[`${propName}_formulaLengths`] = {
				type: 'flat_array',
				of: 'u8',
				capacity: instanceCapacity,
			}

			// Delegate to the flat_array handler for the underlying data structures
			const flatArrayHandler = TypeProcessors.flat_array
			flatArrayHandler.parse(
				`${propName}_rpnStream`,
				{ of: streamDataType, capacity: streamCapacity },
				componentInfo,
				implicitKeys,
				componentName,
			)
			componentInfo.representations[propName].streamLengthProperty = `${propName}_rpnStream_count`

			flatArrayHandler.parse(
				`${propName}_formulaStarts`,
				{ of: 'i16', capacity: instanceCapacity },
				componentInfo,
				implicitKeys,
				componentName,
			)
			flatArrayHandler.parse(
				`${propName}_formulaLengths`,
				{ of: 'u8', capacity: instanceCapacity },
				componentInfo,
				implicitKeys,
				componentName,
			)
		},
	},
})

/**
 * Parses and compiles a component's declarative schema object.
 *
 * This compiler performs a one-time, start-up compilation of a component's schema.
 * It produces the low-level memory layout (`componentInfo`), a pre-compiled object
 * of default values in their final numeric form (`compiledDefaults`), and a set of
 * frozen constants for enums and bitmasks (`constants`).
 *
 * ---
 * ### DEV-NOTE: The Startup Parser
 * This service is the authority for the **one-time, startup schema parsing process**.
 * Its sole responsibility is to read the static `schema` from each component file,
 * calculate its memory layout (`componentInfo`), and pre-compile its constants. It acts
 * as a client of the stateless `ComponentInterpreter` to process the `default` values
 * into their raw, engine-friendly format.
 */
export class SchemaCompiler {
	/**
	 * The main entry point. Parses and compiles a component's schema.
	 * @param {string} componentName - The name of the component.
	 * @param {object} schema - The component's schema object.
	 * @param {number} typeID - The assigned unique ID for this component type.
	 * @returns {{componentInfo: object, constants: object, compiledDefaults: object}}
	 */
	compile(componentName, schema, typeID) {
		const constants = {}
		const compiledDefaults = {}
		// Pass componentName to _parse so it can be stored in componentInfo for TypeProcessors
		const componentInfo = this._parse(componentName, schema, typeID, constants)
		this._compileDefaults(componentInfo, compiledDefaults)
		return { componentInfo, constants, compiledDefaults }
	}

	// --- Stage 1: Parsing Logic (from former SchemaParser.js) ---

	/**
	 * Parses a component's schema into a structured information object.
	 * @param {Function} ComponentClass - The component class.
	 * @param {object} schema - The component's schema object.
	 * @param {number} typeID - The component's type ID.
	 * @param {object} constants - The object to populate with compiled constants (e.g., enums).
	 * @returns {object} The parsed component information object.
	 * @private
	 */
	_parse(componentName, schema, typeID, constants) {
		const componentInfo = {
			typeID,
			componentName, // Store componentName here for TypeProcessors to access
			propertyKeys: [],
			representations: {},
			originalSchemaKeys: [],
			properties: {},
			byteSize: 0,
			alignment: 0,
			sharedProperties: [],
			perEntityProperties: [],
		}

		if (schema === undefined || Object.keys(schema).length === 0) {
			return componentInfo
		}

		const schemaKeys = Object.keys(schema).sort()
		componentInfo.originalSchemaKeys = [...schemaKeys]
		const implicitKeys = []
		for (const propName of schemaKeys) {
			const propDefinition = schema[propName]
			this._parseProperty(propName, propDefinition, componentInfo, implicitKeys, componentName, constants)
		}

		componentInfo.originalSchemaKeys.push(...implicitKeys)
		componentInfo.originalSchemaKeys.sort()

		componentInfo.propertyKeys = [...new Set(componentInfo.propertyKeys)].sort()

		// Determine the alignment for the entire component based on its largest member.
		let maxAlignment = 0
		for (const key of componentInfo.propertyKeys) {
			const prop = componentInfo.properties[key]
			if (!prop) continue
			const propAlignment = prop.alignment || prop.arrayConstructor.BYTES_PER_ELEMENT
			//console.log(`[SchemaCompiler] ${componentName}.${key}: offset=${prop.offset}, size=${prop.arrayConstructor.BYTES_PER_ELEMENT}, alignment=${propAlignment}`);
			maxAlignment = Math.max(maxAlignment, propAlignment)
		}
		componentInfo.alignment = maxAlignment

		for (const propName of componentInfo.originalSchemaKeys) {
			if (componentInfo.representations[propName]?.shared) {
				componentInfo.sharedProperties.push(propName)
			} else {
				componentInfo.perEntityProperties.push(propName)
			}
		}

		// If the component has any shared properties, add a 'prototypeId' to its schema.
		// This ID will be stored on the entity's chunk and point to the actual shared data.
		if (componentInfo.sharedProperties.length > 0) {
			const prototypeIdPropName = 'prototypeId'
			const arrayConstructor = getTypedArrayConstructor('u32')
			const readMethod = `get${arrayConstructor.name.replace('Array', '')}`

			const alignment = arrayConstructor.BYTES_PER_ELEMENT
			if (alignment > 0 && componentInfo.byteSize % alignment !== 0) {
				componentInfo.byteSize += alignment - (componentInfo.byteSize % alignment)
			}
			const offset = componentInfo.byteSize

			componentInfo.properties[prototypeIdPropName] = {
				type: 'u32',
				alignment,
				arrayConstructor,
				readMethod,
				offset,
			}
			componentInfo.propertyKeys.push(prototypeIdPropName)
			componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT
		}

		return componentInfo
	}

	_parseProperty(propName, definitionObject, componentInfo, implicitKeys, componentName, constants) {
		// With the new explicit format, propDefinition is always the definition object.
		if (typeof definitionObject !== 'object' || definitionObject === null || !definitionObject.type) {
			throw new Error(
				`SchemaCompiler: Invalid schema definition for ${componentName}.${propName}. ` +
					`Must be an object with a 'type' property.`,
			)
		}

		// Auto-select storage type for enums and bitmasks if not specified
		const type = definitionObject.type
		if (type === 'enum' || type === 'bitmask') {
			if (!definitionObject.storageType) {
				const numValues = definitionObject.of.length
				const maxFlags = type === 'bitmask' ? numValues : 0
				if (maxFlags <= 8 || numValues <= 256) {
					definitionObject.storageType = 'u8'
				} else if (maxFlags <= 16 || numValues <= 65536) {
					definitionObject.storageType = 'u16'
				} else {
					definitionObject.storageType = 'u32'
				}
			}
		}

		componentInfo.representations[propName] = { ...definitionObject, originalKey: propName }
		const handler = TypeProcessors[type]

		if (handler?.parse) {
			// Pass the definition object directly to the handler.
			handler.parse(propName, definitionObject, componentInfo, implicitKeys, componentName, constants)
		} else {
			// Now that all types are in the handler map, this fallback is no longer needed.
			throw new Error(`SchemaCompiler: Invalid or unsupported type '${type}' for ${componentName}.${propName}.`)
		}
	}

	// --- Stage 2: Default Value Compilation ---

	/**
	 * Compiles `compiledDefaults` object by processing the `default`
	 * values defined in the schema.
	 * @param {object} componentInfo - parsed schema info from _parse().
	 * @param {object} compiledDefaults - object to populate with default values.
	 * @private
	 */
	_compileDefaults(componentInfo, compiledDefaults) {
		for (const propName in componentInfo.representations) {
			const rep = componentInfo.representations[propName]
			if (rep.default === undefined) continue

			// With numeric defaults for enums/bitmasks, we can assign them directly.
			// For other simple types (u8, f32, etc.), default is already a number.
			if (typeof rep.default === 'number' || typeof rep.default === 'boolean') {
				compiledDefaults[propName] = rep.default
			} else if (rep.type === 'flat_array' && Array.isArray(rep.default)) {
				// Handle flat_array defaults directly.
				const len = rep.default.length
				compiledDefaults[rep.lengthProperty] = len
				for (let i = 0; i < len; i++) {
					compiledDefaults[`${propName}${i}`] = rep.default[i]
				}
			}
		}

		// Ensure all properties defined in the final schema have a default value, even if it's 0.
		// This prevents `undefined` values in component arrays.
		for (const propKey of componentInfo.propertyKeys) {
			if (compiledDefaults[propKey] === undefined) {
				compiledDefaults[propKey] = 0
			}
		}
	}
}

export const schemaCompiler = new SchemaCompiler()
