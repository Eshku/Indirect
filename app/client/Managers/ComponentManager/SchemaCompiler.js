const TYPED_ARRAY_MAP = {
	float: Float64Array,
	int: Int32Array,
	integer: Int32Array,
	unsigned: Uint32Array,
	uint: Uint32Array,
	f64: Float64Array,
	f32: Float32Array,
	i32: Int32Array,
	u32: Uint32Array,
	i16: Int16Array,
	u16: Uint16Array,
	i8: Int8Array,
	u8: Uint8Array,
	bool: Uint8Array,
	boolean: Uint8Array, // Alias for u8
}

const { stringInterningTable } = await import(`${PATH_CLIENT}/Indirection/StringInterningTable.js`)

const getTypedArrayConstructor = type => TYPED_ARRAY_MAP[type] || null

/**
 * A registry of processors for different schema property types.
 * Each processor is responsible for parsing its type definition, calculating memory layout,
 * and compiling default values.
 */
const TypeProcessors = {
	// --- Primitive Types (Generated) ---
	// A generic processor for all simple numeric types.
	...Object.keys(TYPED_ARRAY_MAP).reduce((processors, type) => {
		processors[type] = {
			parse(propName, definition, componentInfo) {
				if (definition.shared) return

				const arrayConstructor = getTypedArrayConstructor(definition.type)
				componentInfo.properties[propName] = { type: definition.type, arrayConstructor }
				componentInfo.propertyKeys.push(propName)
				componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT
			},
			processDefault(propName, definition, compiledDefaults) {
				compiledDefaults[propName] = definition.default ?? 0
			},
		}
		return processors
	}, {}),
	// =================================================================
	// Special Scalar Types
	// =================================================================

	string: {
		parse(propName, definition, componentInfo) {
			if (definition.shared) return

			const storageType = 'u32'
			const arrayConstructor = getTypedArrayConstructor(storageType)
			componentInfo.properties[propName] = { type: storageType, arrayConstructor }
			componentInfo.propertyKeys.push(propName)
			componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT
		},
		processDefault(propName, definition, compiledDefaults) {
			const defaultValue = definition.default ?? ''
			compiledDefaults[propName] = stringInterningTable.intern(defaultValue)
		},
	},

	bitmask: {
		parse(propName, definition, componentInfo, implicitKeys, componentName, constants) {
			if (definition.shared) {
				throw new Error(
					`SchemaCompiler: The 'shared' flag is not supported for bitmask properties like '${componentName}.${propName}'.`
				)
			}
			const { storageType, of: values } = definition
			const arrayConstructor = getTypedArrayConstructor(storageType)

			if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) {
				throw new Error(`SchemaCompiler: 'of' for bitmask ${componentName}.${propName} must be an array of strings.`)
			}
			const maxFlags = arrayConstructor.BYTES_PER_ELEMENT * 8
			if (values.length > maxFlags) {
				throw new Error(
					`SchemaCompiler: Too many values for bitmask ${componentName}.${propName}. Type '${storageType}' supports ${maxFlags} flags, but ${values.length} were provided.`
				)
			}

			componentInfo.properties[propName] = { type: storageType, arrayConstructor }
			componentInfo.propertyKeys.push(propName)
			componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT

			const flagMap = {}
			for (let i = 0; i < values.length; i++) {
				flagMap[values[i]] = 1 << i
			}

			componentInfo.representations[propName].flagMap = flagMap
			constants[propName.toUpperCase()] = Object.freeze(flagMap)
		},
		processDefault(propName, definition, compiledDefaults) {
			const defaultValue = definition.default
			if (defaultValue !== undefined) {
				if (!Array.isArray(defaultValue)) {
					throw new Error(`Default for bitmask ${propName} must be an array of strings.`)
				}
				const flagMap = definition.flagMap
				let bitmask = 0
				for (const flagString of defaultValue) {
					const flagValue = flagMap[flagString]
					if (flagValue === undefined) throw new Error(`Invalid default flag "${flagString}" for bitmask ${propName}.`)
					bitmask |= flagValue
				}
				compiledDefaults[propName] = bitmask
			} else {
				compiledDefaults[propName] = 0
			}
		},
	},

	enum: {
		parse(propName, definition, componentInfo, implicitKeys, componentName, constants) {
			const { storageType, of: values } = definition
			const arrayConstructor = getTypedArrayConstructor(storageType)

			if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) {
				throw new Error(`SchemaCompiler: 'of' for enum ${componentName}.${propName} must be an array of strings.`)
			}
			const maxValue = (1 << (arrayConstructor.BYTES_PER_ELEMENT * 8)) - 1
			if (values.length > maxValue + 1) {
				throw new Error(
					`SchemaCompiler: Too many values for enum ${componentName}.${propName}. Type '${storageType}' supports ${
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

			componentInfo.representations[propName].enumMap = enumMap
			componentInfo.representations[propName].valueMap = valueMap
			constants[propName.toUpperCase()] = Object.freeze(enumMap)

			if (definition.shared) return

			componentInfo.properties[propName] = { type: storageType, arrayConstructor }
			componentInfo.propertyKeys.push(propName)
			componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT
		},
		processDefault(propName, definition, compiledDefaults) {
			if (definition.default !== undefined) {
				const index = definition.enumMap[definition.default]
				if (index === undefined) {
					throw new Error(`Invalid default value "${definition.default}" for enum ${propName}.`)
				}
				compiledDefaults[propName] = index
			} else {
				compiledDefaults[propName] = 0 // Default to the first enum value
			}
		},
	},

	// =================================================================
	// Composite / Collection Types
	// =================================================================

	/**
	 * A placeholder for a true variable-length array. This will be implemented
	 * as a "packed array" where all entity data for this component is stored
	 * in a single, contiguous buffer within each chunk.
	 */
	dynamic_array: {
		parse(propName, definition, componentInfo, implicitKeys, componentName) {
			if (definition.shared) {
				throw new Error(
					`SchemaCompiler: The 'shared' flag is not supported for complex types like 'pack_array' in '${componentName}.${propName}'.`
				)
			}
			const { of } = definition

			if (!of) {
				throw new Error(
					`SchemaCompiler: pack_array schema for ${componentName}.${propName} must have an 'of' property.`
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
					`SchemaCompiler: Invalid 'of' type '${itemStorageType}' in pack_array for ${componentName}.${propName}.`
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
			componentInfo.properties[startIndexProperty] = { type: 'u32', arrayConstructor: startIndexConstructor }
			componentInfo.propertyKeys.push(startIndexProperty)
			implicitKeys.push(startIndexProperty)
			componentInfo.byteSize += startIndexConstructor.BYTES_PER_ELEMENT

			const lengthProperty = `${propName}_length`
			const lengthConstructor = getTypedArrayConstructor('u16')
			componentInfo.properties[lengthProperty] = { type: 'u16', arrayConstructor: lengthConstructor }
			componentInfo.propertyKeys.push(lengthProperty)
			implicitKeys.push(lengthProperty)
			componentInfo.byteSize += lengthConstructor.BYTES_PER_ELEMENT
		},
		// pack_array does not generate a program instruction; it's handled by ArchetypeManager.
		processDefault(propName, definition, compiledDefaults) {
			// Packed arrays default to empty.
			compiledDefaults[`${propName}_startIndex`] = -1
			compiledDefaults[`${propName}_length`] = 0
		},
	},

	flat_array: {
		parse(propName, definition, componentInfo, implicitKeys, componentName) {
			if (definition.shared) {
				throw new Error(
					`SchemaCompiler: The 'shared' flag is not supported for complex types like 'flat_array' in '${componentName}.${propName}'.`
				)
			}
			const { of, capacity, lengthProperty: userDefinedLengthProp } = definition
			const len = capacity ?? definition.length

			if (!of) {
				throw new Error(
					`SchemaCompiler: flat_array schema for ${componentName}.${propName} must have an 'of' property.`
				)
			}
			if (typeof len !== 'number' || len <= 0 || !Number.isInteger(len)) {
				throw new Error(
					`SchemaCompiler: Invalid 'capacity' or 'length' for flat_array ${componentName}.${propName}. Must be a positive integer.`
				)
			}

			let itemSchema = of
			if (typeof itemSchema === 'string') {
				itemSchema = { type: itemSchema }
			}

			let itemStorageType
			let itemRepresentation = { ...itemSchema }

			switch (itemSchema.type) {
				case 'string':
					itemStorageType = 'u32'
					break
				case 'enum':
					if (!Array.isArray(itemSchema.of) || itemSchema.of.some(v => typeof v !== 'string'))
						throw new Error(
							`SchemaCompiler: 'of' for enum in flat_array ${componentName}.${propName} must be an array of strings.`
						)
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
				default:
					itemStorageType = itemSchema.type
					break
			}

			const arrayConstructor = getTypedArrayConstructor(itemStorageType)
			if (!arrayConstructor) {
				throw new Error(
					`SchemaCompiler: Invalid 'of' type '${itemStorageType}' in flat_array for ${componentName}.${propName}.`
				)
			}

			componentInfo.representations[propName].itemRepresentation = itemRepresentation
			componentInfo.representations[propName].capacity = len

			const lengthProperty = userDefinedLengthProp || `${propName}_count`
			componentInfo.representations[propName].lengthProperty = lengthProperty
			if (componentInfo.originalSchemaKeys.indexOf(lengthProperty) === -1) {
				const lenPropType = 'u8'
				const lenArrayConstructor = getTypedArrayConstructor(lenPropType)
				componentInfo.properties[lengthProperty] = { type: lenPropType, arrayConstructor: lenArrayConstructor }
				componentInfo.propertyKeys.push(lengthProperty)
				implicitKeys.push(lengthProperty)
				componentInfo.byteSize += lenArrayConstructor.BYTES_PER_ELEMENT
			}

			for (let propIndex = 0; propIndex < len; propIndex++) {
				const key = `${propName}${propIndex}`
				componentInfo.properties[key] = { type: itemStorageType, arrayConstructor }
				componentInfo.propertyKeys.push(key)
				componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT
			}
		},
		processDefault(propName, definition, compiledDefaults) {
			const { capacity, lengthProperty, itemRepresentation } = definition
			const defaultArray = definition.default || []

			if (!Array.isArray(defaultArray)) {
				throw new Error(`Default for flat_array ${propName} must be an array.`)
			}

			const liveLength = Math.min(defaultArray.length, capacity)

			for (let i = 0; i < capacity; i++) {
				const key = `${propName}${i}`
				if (i < liveLength) {
					const value = defaultArray[i]
					switch (itemRepresentation.type) {
						case 'string':
							compiledDefaults[key] = stringInterningTable.intern(value ?? '')
							break
						case 'enum':
							compiledDefaults[key] = itemRepresentation.enumMap[value] ?? 0
							break
						default:
							compiledDefaults[key] = value ?? 0
							break
					}
				} else {
					compiledDefaults[key] = 0 // Fill rest with 0
				}
			}
			compiledDefaults[lengthProperty] = liveLength
		},
	},

	rpn: {
		parse(propName, definition, componentInfo, implicitKeys, componentName, constants) {
			if (definition.shared) {
				throw new Error(
					`SchemaCompiler: The 'shared' flag is not supported for complex types like 'rpn' in '${componentName}.${propName}'.`
				)
			}
			const { streamDataType = 'f32', streamCapacity, instanceCapacity } = definition

			if (typeof streamCapacity !== 'number' || streamCapacity <= 0 || !Number.isInteger(streamCapacity)) {
				throw new Error(
					`SchemaCompiler: Invalid 'streamCapacity' for rpn ${componentName}.${propName}. Must be a positive integer.`
				)
			}
			if (typeof instanceCapacity !== 'number' || instanceCapacity <= 0 || !Number.isInteger(instanceCapacity)) {
				throw new Error(
					`SchemaCompiler: Invalid 'instanceCapacity' for rpn ${componentName}.${propName}. Must be a positive integer.`
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
				componentName
			)
			componentInfo.representations[propName].streamLengthProperty = `${propName}_rpnStream_count`

			flatArrayHandler.parse(
				`${propName}_formulaStarts`,
				{ of: 'i16', capacity: instanceCapacity },
				componentInfo,
				implicitKeys,
				componentName
			)
			flatArrayHandler.parse(
				`${propName}_formulaLengths`,
				{ of: 'u8', capacity: instanceCapacity },
				componentInfo,
				implicitKeys,
				componentName
			)
		},
		processDefault(propName, definition, compiledDefaults) {
			// RPN defaults to empty. The underlying flat_arrays will be handled by their own default processors.
		},
	},
}

/**
 * Parses and compiles a component's declarative schema object.
 *
 * This compiler performs a one-time, start-up compilation of a component's schema.
 * It produces the low-level memory layout (`componentInfo`), a pre-compiled object
 * of default values in their final numeric form (`compiledDefaults`), and a set of
 * frozen constants for enums and bitmasks (`constants`).
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
		const componentInfo = this._parse(componentName, schema, typeID, constants, compiledDefaults)
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
	 * @param {object} compiledDefaults - The object to populate with compiled default values.
	 * @returns {object} The parsed component information object.
	 * @private
	 */
	_parse(componentName, schema, typeID, constants, compiledDefaults) {
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

		if (schema === undefined || Object.keys(schema).length === 0) {
			return componentInfo
		}

		const schemaKeys = Object.keys(schema).sort()
		componentInfo.originalSchemaKeys = [...schemaKeys]
		const implicitKeys = []
		for (const propName of schemaKeys) {
			const propDefinition = schema[propName]
			this._parseProperty(propName, propDefinition, componentInfo, implicitKeys, componentName, constants, compiledDefaults)
		}

		componentInfo.originalSchemaKeys.push(...implicitKeys)
		componentInfo.originalSchemaKeys.sort()

		componentInfo.propertyKeys = [...new Set(componentInfo.propertyKeys)].sort()

		for (const propName of componentInfo.originalSchemaKeys) {
			if (componentInfo.representations[propName]?.shared) {
				componentInfo.sharedProperties.push(propName)
			} else {
				componentInfo.perEntityProperties.push(propName)
			}
		}

		if (componentInfo.sharedProperties.length > 0) {
			const groupIdPropName = 'groupId'
			if (!componentInfo.properties[groupIdPropName]) {
				const arrayConstructor = getTypedArrayConstructor('u32')
				componentInfo.properties[groupIdPropName] = { type: 'u32', arrayConstructor }
				componentInfo.propertyKeys.push(groupIdPropName)
				componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT
			}
		}

		return componentInfo
	}

	_parseProperty(propName, definitionObject, componentInfo, implicitKeys, componentName, constants, compiledDefaults) {
		// With the new explicit format, propDefinition is always the definition object.
		if (typeof definitionObject !== 'object' || definitionObject === null || !definitionObject.type) {
			throw new Error(
				`SchemaCompiler: Invalid schema definition for ${componentName}.${propName}. ` +
					`Must be an object with a 'type' property.`
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
	 * Compiles the `compiledDefaults` object by processing the `default`
	 * values defined in the schema.
	 * @param {object} componentInfo - The parsed schema info from _parse().
	 * @param {object} compiledDefaults - The object to populate with default values.
	 * @private
	 */
	_compileDefaults(componentInfo, compiledDefaults) {
		for (const propName in componentInfo.representations) {
			const rep = componentInfo.representations[propName]
			const handler = TypeProcessors[rep.type]

			handler.processDefault?.(propName, rep, compiledDefaults)
		}
	}
}

export const schemaCompiler = new SchemaCompiler()