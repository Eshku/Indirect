/**
 * A stateless service for transforming "designer-friendly" component data into
 * its "engine-friendly" raw, numeric format. This is the single source of truth
 * for the "write path" of data transformation.
 *
 * It has no dependencies on any managers and can be safely used at any point
 * in the engine's lifecycle, including the initial schema compilation.
 *
 * ---
 * ### DEV-NOTE: The "Write" Transformation Authority
 * This service is the single authority for the **"Write Path" data transformation**.
 * Its sole responsibility is to take a high-level, "designer-friendly" data object
 * and interpret it into its raw, "engine-friendly" numeric equivalent. It is stateless,
 * has no manager dependencies, and can be used safely by any part of the engine at any
 * time (e.g., by `SchemaCompiler` at startup or `PayloadCompiler` at runtime).
 */

const { compileFormulaToRPN } = await import(`${PATH_CORE}/Algorithms/FormulaParser.js`)
const { stringInterningTable } = await import(`${PATH_INDIRECT}/StringInterningTable.js`)
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
			variables: { BASE: [RPN_OP.PUSH_BASE], STR: [RPN_OP.PUSH_STAT, STAT_MAP.STR], DEX: [RPN_OP.PUSH_STAT, STAT_MAP.DEX], INT: [RPN_OP.PUSH_STAT, STAT_MAP.INT], VIT: [RPN_OP.PUSH_STAT, STAT_MAP.VIT] },
			operators: { '+': { precedence: 1, opcode: RPN_OP.ADD }, '-': { precedence: 1, opcode: RPN_OP.SUBTRACT }, '*': { precedence: 2, opcode: RPN_OP.MULTIPLY }, '/': { precedence: 2, opcode: RPN_OP.DIVIDE } },
		},
	}
	return RPN_CONFIG
}

/**
 * Interprets a high-level data object for a given component, returning a new
 * object with raw, engine-friendly values.
 * @param {number} typeID The component's type ID.
 * @param {object} data The high-level data object to interpret.
 * @returns {object} A new object with the interpreted raw data.
 */
export function interpret(typeID, data) {
	const info = Schema.componentInfo[typeID]
	if (!info) return data

	const constants = Schema.componentConstants[typeID]
	const rawData = { ...data } // Work on a copy
	const propKeys = Object.keys(rawData)

	for (const propName of propKeys) {
		const rep = info.representations[propName]
		if (!rep) continue

		const propValue = rawData[propName]
		if (propValue === undefined || typeof propValue === 'number') continue

		switch (rep.type) {
			case 'enum':
				rawData[propName] = constants[propName.toUpperCase()][propValue]
				break
			case 'bitmask':
				rawData[propName] = propValue.reduce((mask, flag) => mask | constants[propName.toUpperCase()][flag], 0)
				break
			case 'string':
				rawData[propName] = stringInterningTable.intern(propValue)
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
						const value = sourceArray[i]
						if (itemRepresentation.originalType === 'string') rawData[key] = stringInterningTable.intern(value ?? '')
						else if (itemRepresentation.originalType === 'enum') rawData[key] = itemRepresentation.enumMap[value] ?? 0
						else rawData[key] = value ?? 0
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
				const rpnStream = [], formulaStarts = [], formulaLengths = []
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