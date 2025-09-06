/**
 * @fileoverview The engine's data transformation service.
 *
 * The ComponentInterpreter is the heart of the "Interpreter" pattern for component data.
 * Its core responsibility is to translate data between two forms:
 *
 * 1.  **"Designer-Friendly" Data:** The human-readable objects developers provide when
 *     creating entities (e.g., `{ state: 'JUMPING', name: 'Player1' }`).
 *
 * 2.  **"Engine-Friendly" Data:** The raw, numeric, and flattened data that is actually
 *     stored in the `TypedArray`s of an Archetype's chunk (e.g., `{ state: 1, name: 123 }`).
 *     This data is optimized for performance and memory layout.
 *
 * It achieves this by executing a pre-compiled "program" (an instruction list generated
 * by the `SchemaCompiler`) on the input data. The `execute` method handles the
 * Designer -> Engine transformation, while the `read` method handles the reverse
 * Engine -> Designer transformation.
 */

import { Opcodes } from './SchemaCompiler.js'

const { compileFormulaToRPN } = await import(`${PATH_CORE}/Algorithms/FormulaParser.js`)

// --- Global RPN Compiler Configuration ---
const RPN_OP = {
	PUSH_LITERAL: -1,
	PUSH_BASE: -2,
	PUSH_STAT: -3,
	ADD: -4,
	SUBTRACT: -5,
	MULTIPLY: -6,
	DIVIDE: -7,
}

const STAT_MAP = { STR: 0, DEX: 1, INT: 2, VIT: 3 }

//! gonna figure out better way to organize it once we have more usecases for it. 
const FORMULA_PARSER_CONFIG = {
	opcodes: RPN_OP,
	variables: {
		BASE: [RPN_OP.PUSH_BASE],
		STR: [RPN_OP.PUSH_STAT, STAT_MAP.STR],
		DEX: [RPN_OP.PUSH_STAT, STAT_MAP.DEX],
		INT: [RPN_OP.PUSH_STAT, STAT_MAP.INT],
		VIT: [RPN_OP.PUSH_STAT, STAT_MAP.VIT],
	},
	operators: {
		'+': { precedence: 1, opcode: RPN_OP.ADD },
		'-': { precedence: 1, opcode: RPN_OP.SUBTRACT },
		'*': { precedence: 2, opcode: RPN_OP.MULTIPLY },
		'/': { precedence: 2, opcode: RPN_OP.DIVIDE },
	},
}
// ----------------------------------------

class ComponentInterpreter {
	/**
	 * The constructor is now internal. The singleton instance is created below.
	 */
	constructor() {
		this.stringManager = null
		this.componentInfo = null
		this.archetypeManager = null
	}

	/**
	 * Initializes the interpreter with its required manager dependencies.
	 * This is called once by the ComponentManager during the engine's startup sequence.
	 * @param {object} dependencies
	 * @param {import('./StringManager.js').StringManager} dependencies.stringManager
	 * @param {object[]} dependencies.componentInfo
	 * @param {import('../ArchetypeManager/ArchetypeManager.js').ArchetypeManager} dependencies.archetypeManager
	 */
	init({ stringManager, componentInfo, archetypeManager }) {
		this.stringManager = stringManager
		this.componentInfo = componentInfo
		this.archetypeManager = archetypeManager
	}

	/**
	 * Executes a program on a data object, mutating it in place.
	 * @param {Array<object>} program - The compiled instruction list.
	 * @param {object} data - The "designer-friendly" data to process.
	 * @param {string} componentName - The name of the component, for error messages.
	 */
	execute(program, data, componentName) {
		for (const instruction of program) {
			const propValue = data[instruction.prop]
			if (propValue === undefined || typeof propValue === 'number') {
				// Already processed or not provided, skip.
				continue
			}

			switch (instruction.op) {
				case Opcodes.PROCESS_ENUM:
					this._handleEnum(data, propValue, instruction, componentName)
					break

				case Opcodes.PROCESS_BITMASK:
					this._handleBitmask(data, propValue, instruction, componentName)
					break

				case Opcodes.PROCESS_STRING:
					this._handleString(data, propValue, instruction)
					break

				case Opcodes.PROCESS_FLAT_ARRAY:
					this._handleFlatArray(data, propValue, instruction, componentName)
					break

				case Opcodes.PROCESS_RPN: {
					this._handleRpn(data, propValue, instruction)
					break
				}
			}
		}
	}

	// --- Private Write/Processing Helpers ---
	// These are the self-contained handlers for each instruction type.

	_handleEnum(data, propValue, instruction, componentName) {
		data[instruction.prop] = this._processEnumValue(propValue, instruction, componentName)
	}

	_handleBitmask(data, propValue, instruction, componentName) {
		data[instruction.prop] = this._processBitmaskValue(propValue, instruction, componentName)
	}

	_handleString(data, propValue, instruction) {
		data[instruction.prop] = this._processStringValue(propValue)
	}

	_handleFlatArray(data, propValue, instruction, componentName) {
		const { schema } = instruction
		const itemProcessor = value => this._processItem(value, schema.itemRepresentation, componentName)
		this._flattenArrayIntoData(data, propValue, instruction.prop, schema.capacity, schema.lengthProperty, itemProcessor)
		delete data[instruction.prop]
	}

	_handleRpn(data, propValue, instruction) {
		if (!Array.isArray(propValue)) {
			throw new Error(`RPN property "${instruction.prop}" must be an array of formula strings.`)
		}
		const { schema } = instruction
		const { streamProperty, startsProperty, lengthsProperty, instanceCapacity, streamCapacity, streamLengthProperty } =
			schema

		const rpnStream = []
		const formulaStarts = []
		const formulaLengths = []
		const liveLength = Math.min(propValue.length, instanceCapacity)

		for (let i = 0; i < liveLength; i++) {
			const formulaString = propValue[i]
			if (formulaString) {
				const rpn = compileFormulaToRPN(formulaString, FORMULA_PARSER_CONFIG)
				formulaStarts.push(rpn.length > 0 ? rpnStream.length : -1)
				formulaLengths.push(rpn.length)
				rpnStream.push(...rpn)
			} else {
				formulaStarts.push(-1)
				formulaLengths.push(0)
			}
		}

		for (let i = liveLength; i < instanceCapacity; i++) {
			formulaStarts.push(-1)
			formulaLengths.push(0)
		}

		// This handler is now self-contained. It calls the flattener directly for all three
		// of its internal arrays, rather than relying on other instructions.
		this._flattenArrayIntoData(data, rpnStream, streamProperty, streamCapacity, streamLengthProperty)
		this._flattenArrayIntoData(
			data,
			formulaStarts,
			startsProperty,
			instanceCapacity,
			`${startsProperty}_count`,
			v => v,
			liveLength
		)
		this._flattenArrayIntoData(
			data,
			formulaLengths,
			lengthsProperty,
			instanceCapacity,
			`${lengthsProperty}_count`,
			v => v,
			liveLength
		)

		delete data[instruction.prop]
	}

	/**
	 * Processes a single item within a flat_array. This is the "recursive" part of the interpreter.
	 * @private
	 */
	_processItem(value, itemSchema, componentName) {
		if (value === undefined || typeof value === 'number') return value

		switch (itemSchema.type) {
			case 'enum':
				// For enums in arrays, the schema is nested.
				return this._processEnumValue(value, { values: itemSchema.of }, componentName)
			case 'string':
				return this._processStringValue(value)
			// Future types like 'bitmask' could be added here.
			default:
				return value // Primitive
		}
	}

	/**
	 * Converts an enum string to its numeric index.
	 * @private
	 */
	_processEnumValue(value, instruction, componentName) {
		const index = instruction.values.indexOf(value)
		if (index === -1) {
			throw new Error(
				`Invalid enum value "${value}" for property "${
					instruction.prop
				}" in component "${componentName}". Valid values are: [${instruction.values.join(', ')}]`
			)
		}
		return index
	}

	/**
	 * Converts an array of bitmask flag strings to a single integer.
	 * @private
	 */
	_processBitmaskValue(value, instruction, componentName) {
		if (!Array.isArray(value)) {
			throw new Error(
				`Invalid bitmask value for property "${instruction.prop}" in component "${componentName}". Expected an array of strings.`
			)
		}
		let bitmask = 0
		for (const flagString of value) {
			const index = instruction.values.indexOf(flagString)
			if (index === -1) {
				throw new Error(
					`Invalid bitmask flag "${flagString}" for property "${
						instruction.prop
					}" in component "${componentName}". Valid flags are: [${instruction.values.join(', ')}]`
				)
			}
			bitmask |= 1 << index
		}
		return bitmask
	}

	/**
	 * Converts a string to its interned numeric ID.
	 * @private
	 */
	_processStringValue(value) {
		return this.stringManager.intern(value ?? '')
	}

	/**
	 * Flattens a source array into individual properties on a data object.
	 * @param {object} data - The data object to mutate.
	 * @param {Array} sourceArray - The array of values to flatten.
	 * @param {string} basePropName - The base name for the flattened properties (e.g., 'myArray').
	 * @param {number} capacity - The total storage capacity.
	 * @param {string} lengthProperty - The name of the property to store the array's length.
	 * @param {Function} [itemProcessor=v=>v] - A function to process each item before storage.
	 * @param {number} [logicalLength] - The explicit logical length to use, overriding inference from sourceArray.
	 * @private
	 */
	_flattenArrayIntoData(
		data,
		sourceArray,
		basePropName,
		capacity,
		lengthProperty,
		itemProcessor = v => v,
		logicalLength
	) {
		const liveLength = Math.min(sourceArray.length, capacity)

		for (let i = 0; i < capacity; i++) {
			const key = `${basePropName}${i}`
			if (i < liveLength) {
				const processedItem = itemProcessor(sourceArray[i])
				if (processedItem === undefined) {
					throw new Error(`Item processor for array "${basePropName}" returned undefined for value: ${sourceArray[i]}`)
				}
				data[key] = processedItem
			} else {
				data[key] = 0
			}
		}
		// Use the provided logicalLength if it exists, otherwise infer from the source array.
		data[lengthProperty] = logicalLength ?? liveLength
	}

	/**
	 * Reads and reconstructs component data from its raw, engine-friendly format
	 * back into a designer-friendly object.
	 * @param {number} entityId
	 * @param {number} componentTypeId
	 * @param {number} archetype
	 * @returns {object | undefined}
	 */
	read(entityId, componentTypeId, archetype) {
		if (!this.archetypeManager) {
			throw new Error('ComponentInterpreter: Interpreter has not been initialized. Cannot read component data.')
		}
		const location = this.archetypeManager.archetypeEntityMaps[archetype]?.get(entityId)
		if (!location || !this.archetypeManager.hasComponentType(archetype, componentTypeId)) return undefined

		const { chunk, indexInChunk } = location
		const componentData = {}
		const info = this.componentInfo[componentTypeId]

		for (const propName of info.originalSchemaKeys) {
			const rep = info.representations[propName]
			if (!rep) continue

			if (rep.shared) {
				continue
			}

			const componentArrays = chunk.componentArrays[componentTypeId]

			if (rep.type === 'rpn') {
				// For debugging/testing, we read the raw flattened count properties.
				// This confirms that the 'write' path processing was successful.
				const streamLengthProp = rep.streamLengthProperty
				if (componentArrays[streamLengthProp]) {
					componentData[streamLengthProp] = componentArrays[streamLengthProp][indexInChunk]
				}
				const startsCountProp = `${rep.startsProperty}_count`
				if (componentArrays[startsCountProp]) {
					componentData[startsCountProp] = componentArrays[startsCountProp][indexInChunk]
				}
				const lengthsCountProp = `${rep.lengthsProperty}_count`
				if (componentArrays[lengthsCountProp]) {
					componentData[lengthsCountProp] = componentArrays[lengthsCountProp][indexInChunk]
				}
			} else if (rep.type === 'flat_array') {
				const sourceArray = []
				const len = componentArrays[rep.lengthProperty][indexInChunk]
				const itemRep = rep.itemRepresentation
				for (let i = 0; i < len; i++) {
					const rawValue = componentArrays[`${propName}${i}`][indexInChunk]
					sourceArray.push(this._reconstructItem(rawValue, itemRep))
				}
				componentData[propName] = sourceArray
			} else if (rep.type === 'enum') {
				const rawValue = componentArrays[propName][indexInChunk]
				componentData[propName] = this._reconstructEnumValue(rawValue, rep)
			} else if (rep.type === 'bitmask') {
				const rawValue = componentArrays[propName][indexInChunk]
				componentData[propName] = this._reconstructBitmaskValue(rawValue, rep)
			} else if (rep.type === 'string') {
				const rawValue = componentArrays[propName][indexInChunk]
				componentData[propName] = this._reconstructStringValue(rawValue)
			} else if (componentArrays && componentArrays[propName]) {
				componentData[propName] = componentArrays[propName][indexInChunk]
			}
		}

		if (info.sharedProperties.length > 0) {
			const componentArrays = chunk.componentArrays[componentTypeId]
			if (componentArrays && componentArrays.groupId) {
				componentData.groupId = componentArrays.groupId[indexInChunk]
			}
		}
		return componentData
	}

	/**
	 * Reconstructs a single raw value from within a flat_array.
	 */
	_reconstructItem(rawValue, itemSchema) {
		if (!itemSchema) return rawValue

		switch (itemSchema.type) {
			case 'string':
				return this._reconstructStringValue(rawValue)
			case 'enum':
				return this._reconstructEnumValue(rawValue, itemSchema)
			default:
				return rawValue
		}
	}

	/**
	 * Converts a numeric enum index back to its string value.
	 */
	_reconstructEnumValue(rawValue, schema) {
		return schema.valueMap[rawValue]
	}

	/**
	 * Converts an integer bitmask back to an array of its active flag strings.
	 */
	_reconstructBitmaskValue(rawValue, schema) {
		const flags = []
		for (const flagName in schema.flagMap) {
			if ((rawValue & schema.flagMap[flagName]) !== 0) {
				flags.push(flagName)
			}
		}
		return flags
	}

	/**
	 * Converts an interned string ID back to the original string.
	 */
	_reconstructStringValue(rawValue) {
		return this.stringManager.get(rawValue)
	}
}

/**
 * The singleton instance of the ComponentInterpreter.
 * This is the central service for translating component data between designer-friendly and engine-friendly formats.
 */
export const componentInterpreter = new ComponentInterpreter()
