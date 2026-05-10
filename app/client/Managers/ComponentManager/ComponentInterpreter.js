/**
 * A stateless service for transforming component data between its "designer-friendly"
 * high-level format (e.g., objects with strings) and its "engine-friendly" raw,
 * numeric format. This is the single source of truth for both the "write" and "read"
 * data transformation paths.
 *
 * It has no dependencies on any managers and can be safely used at any point
 * in the engine's lifecycle, including the initial schema compilation.
 *
 * ---
 * ### DEV-NOTE: The "Write" Transformation Authority
 * This service is the single authority for the **"Write Path" data transformation**.
 * Its responsibility is to take a high-level, "designer-friendly" data object
 * and interpret it into its raw, "engine-friendly" numeric equivalent. It also handles
 * the reverse "reconstruction" process. It is stateless and has no manager dependencies.
 */

const { compileFormulaToRPN } = await import(`@core/Algorithms/FormulaParser.js`)
const { stringInterningTable } = await import(`@indirect/StringInterningTable.js`)
import * as Schema from './ComponentSchema.js'

let RPN_CONFIG = null

function getRpnConfig() {
	if (RPN_CONFIG) return RPN_CONFIG
	const RPN_OP = { PUSH_LITERAL: -1, PUSH_BASE: -2, PUSH_STAT: -3, ADD: -4, SUBTRACT: -5, MULTIPLY: -6, DIVIDE: -7 }
	const STAT_MAP = { STR: 0, DEX: 1, INT: 2, VIT: 3 }
	RPN_CONFIG = {
		RPN_OP,
		FORMULA_PARSER_CONFIG: {
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
		},
	}
	return RPN_CONFIG
}

/**
 * Expands shorthands and applies schema defaults to a component data object.
 * This produces a "fully-specified" high-level data object.
 * It does NOT convert values (e.g. string to ID).
 * @param {number} typeID The component's type ID.
 * @param {object | primitive} data The high-level data.
 * @returns {object} A new object with shorthands expanded and defaults applied.
 */
export function resolveComponentData(typeID, data) {
	const info = Schema.componentInfo[typeID]
	if (!info) {
		// If we don't know the component, we can't resolve it. Return as-is.
		return data
	}

	let objectData = data

	// Step 1: Handle shorthand.
	const dataType = typeof objectData
	if (dataType === 'number' || dataType === 'string' || dataType === 'boolean') {
		if (info.originalSchemaKeys && info.originalSchemaKeys.length > 0) {
			const firstPropKey = info.originalSchemaKeys[0]
			objectData = { [firstPropKey]: objectData }
		} else {
			console.error(`ComponentInterpreter: Invalid shorthand for component "${info.componentName}". Tag components cannot have data.`)
			objectData = {}
		}
	} else if (objectData === null || typeof objectData !== 'object') {
		// Handle null or other invalid types by treating them as an empty object,
		// which will then be filled with defaults.
		objectData = {}
	}

	// Step 2: Apply high-level defaults from the schema.
	const highLevelDefaults = {}
	for (const propName of info.originalSchemaKeys) {
		const rep = info.representations[propName]
		if (rep && rep.default !== undefined) {
			highLevelDefaults[propName] = rep.default
		}
	}

	return { ...highLevelDefaults, ...objectData }
}

/**
 * WRITE PATH:
 * Interprets a high-level data object for a given component, returning a new
 * object with raw, engine-friendly values.
 * @param {number} typeID The component's type ID.
 * @param {object} data The high-level data object to interpret.
 * @returns {object} A new object with the interpreted raw data.
 */
export function interpret(typeID, data) {
	const info = Schema.componentInfo[typeID]
	if (!info) return data 

	const rawData = { ...data } // Work on a copy
	const propKeys = Object.keys(rawData)

	// This loop handles the direct properties provided in the `data` object.
	for (const propName of propKeys) {
		const rep = info.representations[propName]
		if (!rep) continue

		const propValue = rawData[propName]
		if (propValue === undefined || typeof propValue === 'number') continue

		switch (rep.type) {
			case 'string':
				rawData[propName] = stringInterningTable.intern(propValue)
				break
			case 'component':
				const typeId = Schema.componentNameToTypeID.get(propValue.toLowerCase())
				if (typeId === undefined) {
					console.warn(`ComponentInterpreter: Unknown component name "${propValue}" for property "${propName}".`)
					rawData[propName] = 0 // Use 0 as a sentinel for unknown component
				} else {
					rawData[propName] = typeId
				}
				break
			case 'boolean':
			case 'bool':
				rawData[propName] = propValue ? 1 : 0
				break
			case 'entity':
				// Ensure entity IDs are always treated as BigInts.
				rawData[propName] = BigInt(propValue || 0)
				break
			case 'flat_array': {
				const { capacity, lengthProperty, itemRepresentation } = rep
				const sourceArray = propValue || []
				const liveLength = Math.min(sourceArray.length, capacity)
				for (let i = 0; i < capacity; i++) {
					const key = `${propName}${i}`
					if (i < liveLength) {
						const value = sourceArray[i] ?? 0
						let interpretedValue = value
						// Interpret string-based values for enums and strings within the array.
						if (itemRepresentation.originalType === 'string' && typeof value === 'string') {
							interpretedValue = stringInterningTable.intern(value)
						} else if (itemRepresentation.originalType === 'component' && typeof value === 'string') {
							const typeId = Schema.componentNameToTypeID.get(value.toLowerCase())
							if (typeId === undefined) {
								console.warn(`ComponentInterpreter: Unknown component name "${value}" in flat_array "${propName}".`)
								interpretedValue = 0 // Use 0 as a sentinel
							} else {
								interpretedValue = typeId
							}
						} else if (itemRepresentation.originalType === 'entity') {
							// Ensure entity IDs are always BigInts.
							interpretedValue = BigInt(value || 0)
						}
						rawData[key] = interpretedValue
					} else {
						rawData[key] = 0
					}
				}
				rawData[lengthProperty] = liveLength
				delete rawData[propName]
				break
			}
			case 'rpn': {
				const { FORMULA_PARSER_CONFIG } = getRpnConfig()
				const { streamProperty, startsProperty, lengthsProperty, instanceCapacity } = rep
				const rpnStream = [],
					formulaStarts = [],
					formulaLengths = []
				const liveLength = Math.min(propValue.length, instanceCapacity)
				for (let i = 0; i < liveLength; i++) {
					const rpn = propValue[i] ? compileFormulaToRPN(propValue[i], FORMULA_PARSER_CONFIG) : []
					formulaStarts.push(rpn.length > 0 ? rpnStream.length : -1)
					formulaLengths.push(rpn.length)
					rpnStream.push(...rpn)
				}
				rawData[streamProperty] = rpnStream
				rawData[startsProperty] = formulaStarts
				rawData[lengthsProperty] = formulaLengths
				propKeys.push(streamProperty, startsProperty, lengthsProperty)
				delete rawData[propName]
				break
			}
		}
	}
	return rawData
}

/**
 * READ PATH:
 * Reconstructs a high-level, "designer-friendly" data object from a raw,
 * engine-friendly data object.
 * @param {number} typeID The component's type ID.
 * @param {object} rawData The raw data object to reconstruct.
 * @returns {object} A new object with the reconstructed high-level data.
 */
export function reconstruct(typeID, rawData) {
	const info = Schema.componentInfo[typeID]
	if (!info || !rawData) return {}

	const highLevelData = {}

	// Iterate over the original schema keys to reconstruct complex types correctly.
	for (const propName of info.originalSchemaKeys) {
		const rep = info.representations[propName]
		if (!rep || rep.shared) continue

		const rawValue = rawData[propName]

		switch (rep.type) {
			case 'string':
				highLevelData[propName] = stringInterningTable.get(rawValue)
				break
			case 'component':
				// Return the component's string name. Returns undefined if ID is invalid.
				highLevelData[propName] = Schema.componentNames[rawValue]
				break
			case 'flat_array': {
				const sourceArray = []
				const len = rawData[rep.lengthProperty]
				const itemRep = rep.itemRepresentation
				for (let i = 0; i < len; i++) {
					const value = rawData[`${propName}${i}`]
					let reconstructedValue = value
					if (itemRep.originalType === 'string') {
						reconstructedValue = stringInterningTable.get(value)
					} else if (itemRep.originalType === 'component') {
						reconstructedValue = Schema.componentNames[value]
					} else if (itemRep.originalType === 'entity') {
						reconstructedValue = value // Already a BigInt, pass through
					}
					sourceArray.push(reconstructedValue)
				}
				highLevelData[propName] = sourceArray
				break
			}
			case 'rpn': {
				// This is a no-op. The 'rpn' type is virtual on the read path.
				// The underlying flat arrays (`_rpnStream`, etc.) are reconstructed by their own 'flat_array' case.
				break
			}
			default: // Primitives
				if (rawValue !== undefined) highLevelData[propName] = rawValue
				break
		}
	}
	return highLevelData
}
