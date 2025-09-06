/**
 * @fileoverview Parses and compiles a component's static schema into a structured
 * memory blueprint (`componentInfo`) and a data transformation "program"
 * (an instruction list for the ComponentInterpreter).
 *

 */

const TYPED_ARRAY_MAP = {
	bool: Uint8Array,
	boolean: Uint8Array,
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
}

const getTypedArrayConstructor = type => TYPED_ARRAY_MAP[type] || null

/**
 * A registry of handlers for processing different schema property types.
 * Each handler is responsible for parsing its type definition, calculating memory layout,
 * and defining any necessary runtime transformation logic.
 */
const TypeHandlers = {
	// --- Simple Numeric Types ---
	...Object.keys(TYPED_ARRAY_MAP).reduce((acc, type) => {
		acc[type] = {
			parse(propName, definition, componentInfo) {
				if (definition.shared) return

				const arrayConstructor = getTypedArrayConstructor(type)
				componentInfo.properties[propName] = { type, arrayConstructor }
				componentInfo.propertyKeys.push(propName)
				componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT
			},
		}
		return acc
	}, {}),

	// --- Complex Types ---

	string: {
		parse(propName, definition, componentInfo) {
			if (definition.shared) return

			const storageType = 'u32'
			const arrayConstructor = getTypedArrayConstructor(storageType)
			componentInfo.properties[propName] = { type: storageType, arrayConstructor }
			componentInfo.propertyKeys.push(propName)
			componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT
		},
		compile(propName) {
			return { op: Opcodes.PROCESS_STRING, prop: propName }
		},
	},

	bitmask: {
		parse(propName, definition, componentInfo, implicitKeys, ComponentClass) {
			if (definition.shared) {
				throw new Error(
					`SchemaCompiler: The 'shared' flag is not supported for bitmask properties like '${ComponentClass.name}.${propName}'.`
				)
			}
			const { storageType, of: values } = definition
			const arrayConstructor = getTypedArrayConstructor(storageType)

			if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) {
				throw new Error(
					`SchemaCompiler: 'of' for bitmask ${ComponentClass.name}.${propName} must be an array of strings.`
				)
			}
			const maxFlags = arrayConstructor.BYTES_PER_ELEMENT * 8
			if (values.length > maxFlags) {
				throw new Error(
					`SchemaCompiler: Too many values for bitmask ${ComponentClass.name}.${propName}. Type '${storageType}' supports ${maxFlags} flags, but ${values.length} were provided.`
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
			ComponentClass[propName.toUpperCase()] = Object.freeze(flagMap)
		},
		compile(propName, representation) {
			return { op: Opcodes.PROCESS_BITMASK, prop: propName, values: representation.values }
		},
	},

	enum: {
		parse(propName, definition, componentInfo, implicitKeys, ComponentClass) {
			const { storageType, of: values } = definition
			const arrayConstructor = getTypedArrayConstructor(storageType)

			if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) {
				throw new Error(`SchemaCompiler: 'of' for enum ${ComponentClass.name}.${propName} must be an array of strings.`)
			}
			const maxValue = (1 << (arrayConstructor.BYTES_PER_ELEMENT * 8)) - 1
			if (values.length > maxValue + 1) {
				throw new Error(
					`SchemaCompiler: Too many values for enum ${ComponentClass.name}.${propName}. Type '${storageType}' supports ${
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
			ComponentClass[propName.toUpperCase()] = Object.freeze(enumMap)

			if (definition.shared) return

			componentInfo.properties[propName] = { type: storageType, arrayConstructor }
			componentInfo.propertyKeys.push(propName)
			componentInfo.byteSize += arrayConstructor.BYTES_PER_ELEMENT
		},
		compile(propName, representation) {
			return { op: Opcodes.PROCESS_ENUM, prop: propName, values: representation.values }
		},
	},

	pack_array: {
		parse(propName, definition, componentInfo, implicitKeys, ComponentClass) {
			if (definition.shared) {
				throw new Error(
					`SchemaCompiler: The 'shared' flag is not supported for complex types like 'pack_array' in '${ComponentClass.name}.${propName}'.`
				)
			}
			const { of } = definition

			if (!of) {
				throw new Error(
					`SchemaCompiler: pack_array schema for ${ComponentClass.name}.${propName} must have an 'of' property.`
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
					`SchemaCompiler: Invalid 'of' type '${itemStorageType}' in pack_array for ${ComponentClass.name}.${propName}.`
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
		compile() {
			return null
		},
	},

	flat_array: {
		parse(propName, definition, componentInfo, implicitKeys, ComponentClass) {
			if (definition.shared) {
				throw new Error(
					`SchemaCompiler: The 'shared' flag is not supported for complex types like 'flat_array' in '${ComponentClass.name}.${propName}'.`
				)
			}
			const { of, capacity, lengthProperty: userDefinedLengthProp } = definition
			const len = capacity ?? definition.length

			if (!of) {
				throw new Error(
					`SchemaCompiler: flat_array schema for ${ComponentClass.name}.${propName} must have an 'of' property.`
				)
			}
			if (typeof len !== 'number' || len <= 0 || !Number.isInteger(len)) {
				throw new Error(
					`SchemaCompiler: Invalid 'capacity' or 'length' for flat_array ${ComponentClass.name}.${propName}. Must be a positive integer.`
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
							`SchemaCompiler: 'of' for enum in flat_array ${ComponentClass.name}.${propName} must be an array of strings.`
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
					`SchemaCompiler: Invalid 'of' type '${itemStorageType}' in flat_array for ${ComponentClass.name}.${propName}.`
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
		compile(propName, representation) {
			return { op: Opcodes.PROCESS_FLAT_ARRAY, prop: propName, schema: representation }
		},
	},

	rpn: {
		parse(propName, definition, componentInfo, implicitKeys, ComponentClass) {
			if (definition.shared) {
				throw new Error(
					`SchemaCompiler: The 'shared' flag is not supported for complex types like 'rpn' in '${ComponentClass.name}.${propName}'.`
				)
			}
			const { streamDataType = 'f32', streamCapacity, instanceCapacity } = definition

			if (typeof streamCapacity !== 'number' || streamCapacity <= 0 || !Number.isInteger(streamCapacity)) {
				throw new Error(
					`SchemaCompiler: Invalid 'streamCapacity' for rpn ${ComponentClass.name}.${propName}. Must be a positive integer.`
				)
			}
			if (typeof instanceCapacity !== 'number' || instanceCapacity <= 0 || !Number.isInteger(instanceCapacity)) {
				throw new Error(
					`SchemaCompiler: Invalid 'instanceCapacity' for rpn ${ComponentClass.name}.${propName}. Must be a positive integer.`
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
			componentInfo.representations[`${propName}_formulaStarts`] = { type: 'flat_array', of: 'i16', capacity: instanceCapacity }
			componentInfo.representations[`${propName}_formulaLengths`] = { type: 'flat_array', of: 'u8', capacity: instanceCapacity }

			// Delegate to the flat_array handler for the underlying data structures
			const flatArrayHandler = TypeHandlers.flat_array
			flatArrayHandler.parse(
				`${propName}_rpnStream`,
				{ of: streamDataType, capacity: streamCapacity },
				componentInfo,
				implicitKeys,
				ComponentClass
			)
			componentInfo.representations[propName].streamLengthProperty = `${propName}_rpnStream_count`

			flatArrayHandler.parse(
				`${propName}_formulaStarts`,
				{ of: 'i16', capacity: instanceCapacity },
				componentInfo,
				implicitKeys,
				ComponentClass
			)
			flatArrayHandler.parse(
				`${propName}_formulaLengths`,
				{ of: 'u8', capacity: instanceCapacity },
				componentInfo,
				implicitKeys,
				ComponentClass
			)
		},
		compile(propName, representation) {
			return { op: Opcodes.PROCESS_RPN, prop: propName, schema: representation }
		},
	},
}

export const Opcodes = Object.freeze({
	PROCESS_ENUM: 'enum',
	PROCESS_BITMASK: 'bitmask',
	PROCESS_STRING: 'string',
	PROCESS_FLAT_ARRAY: 'flat_array',
	PROCESS_RPN: 'rpn',
})

export class SchemaCompiler {
	/**
	 * The main entry point. Parses and compiles a component's schema.
	 * @param {Function} ComponentClass - The component class to process.
	 * @param {number} typeID - The assigned unique ID for this component type.
	 * @param {import('./StringManager.js').StringManager} stringManager - The engine's string manager.
	 * @returns {{componentInfo: object, program: Array<object>|null}}
	 */
	compile(ComponentClass, typeID, stringManager) {
		const componentInfo = this._parse(ComponentClass, typeID, stringManager)
		const program = this._compileProgram(componentInfo)
		return { componentInfo, program }
	}

	// --- Stage 1: Parsing Logic (from former SchemaParser.js) ---

	/**
	 * Parses a component's schema into a structured information object.
	 * @param {Function} ComponentClass - The component class.
	 * @param {number} typeID - The component's type ID.
	 * @param {import('./StringManager.js').StringManager} stringManager - The engine's string manager.
	 * @returns {object} The parsed component information object.
	 * @private
	 */
	_parse(ComponentClass, typeID, stringManager) {
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
			return componentInfo
		}

		const schemaKeys = Object.keys(schema).sort()
		componentInfo.originalSchemaKeys = [...schemaKeys]
		const implicitKeys = []
		for (const propName of schemaKeys) {
			const propDefinition = schema[propName]
			this._parseProperty(propName, propDefinition, componentInfo, implicitKeys, ComponentClass)
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

	_parseProperty(propName, propDefinition, componentInfo, implicitKeys, ComponentClass) {
		let definitionObject = propDefinition

		if (typeof propDefinition === 'string') {
			definitionObject = { type: propDefinition }
		}

		if (typeof definitionObject === 'object') {
			const type = definitionObject.type
			switch (type) {
				case 'string':
					definitionObject.storageType = 'u32'
					break
				case 'enum':
					if (definitionObject.of.length <= 256) {
						definitionObject.storageType = 'u8'
					} else if (definitionObject.of.length <= 65536) {
						definitionObject.storageType = 'u16'
					} else {
						definitionObject.storageType = 'u32'
					}
					break
				case 'bitmask':
					if (definitionObject.of.length <= 8) {
						definitionObject.storageType = 'u8'
					} else if (definitionObject.of.length <= 16) {
						definitionObject.storageType = 'u16'
					} else if (definitionObject.of.length <= 32) {
						definitionObject.storageType = 'u32'
					} else {
						throw new Error(
							`SchemaCompiler: Bitmask for ${ComponentClass.name}.${propName} has too many values (${definitionObject.of.length}). Maximum supported is 32.`
						)
					}
					break
			}
		}

		if (typeof definitionObject !== 'object' || !definitionObject.type) {
			throw new Error(
				`SchemaCompiler: Invalid schema definition for ${ComponentClass.name}.${propName}. ` +
					`Could not determine a valid type.`
			)
		}

		componentInfo.representations[propName] = { ...definitionObject, originalKey: propName }
		const type = definitionObject.type
		const handler = TypeHandlers[type]

		if (handler?.parse) {
			handler.parse(propName, definitionObject, componentInfo, implicitKeys, ComponentClass)
		} else {
			// Now that all types are in the handler map, this fallback is no longer needed.
			throw new Error(`SchemaCompiler: Invalid or unsupported type '${type}' for ${ComponentClass.name}.${propName}.`)
		}
	}

	// --- Stage 2: Program Compilation Logic ---

	/**
	 * Compiles a component's parsed info into a list of processing instructions.
	 * @param {object} componentInfo - The parsed schema info from _parse().
	 * @returns {Array<object>|null} An array of instruction objects, or null if no processing is needed.
	 * @private
	 */
	_compileProgram(componentInfo) {
		const instructions = []

		for (const propName in componentInfo.representations) {
			const rep = componentInfo.representations[propName]
			const handler = TypeHandlers[rep.type]

			if (handler?.compile) {
				const instruction = handler.compile(propName, rep)
				if (instruction) instructions.push(instruction)
			}
		}

		return instructions.length > 0 ? instructions : null
	}
}
