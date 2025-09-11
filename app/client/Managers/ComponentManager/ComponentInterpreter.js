/**
 * dedicated service for transforming "designer-friendly" component
 * data into its "engine-friendly" raw, numeric format.
 *
 * This interpreter is used exclusively for the "slow path" of data creation, such
 * as `ECS.createEntity()` or `ECS.addComponent()`. It is not used in any
 * performance-critical loops. It directly mutates the data object it receives.
 */

const { compileFormulaToRPN } = await import(`${PATH_CORE}/Algorithms/FormulaParser.js`)
const { stringInterningTable } = await import(`${PATH_CLIENT}/Indirection/StringInterningTable.js`)

class ComponentInterpreter {
	constructor() {
		this.componentManager = null
		this._rpnConfig = null
	}

	/**
	 * Initializes the interpreter with its required manager dependencies.
	 * This is called once by the ComponentManager during the engine's startup sequence.
	 * @param {{componentManager: import('./ComponentManager.js').ComponentManager}} dependencies
	 */
	init({ componentManager }) {
		this.componentManager = componentManager
	}

	/**
	 * Processes a component data object, mutating it in place.
	 * @param {number} typeID - The component's type ID.
	 * @param {object} data - The "designer-friendly" data to process.
	 */
	process(typeID, data) {
		const info = this.componentManager.componentInfo[typeID]
		const constants = this.componentManager.componentConstants[typeID]

		// Use a copy of keys because we might add new keys during processing (for RPN)
		const propKeys = Object.keys(data)

		for (const propName of propKeys) {
			const rep = info.representations[propName]
			if (!rep) continue

			const propValue = data[propName]
			if (propValue === undefined || typeof propValue === 'number') continue

			switch (rep.type) {
				case 'enum': {
					const enumMap = constants[propName.toUpperCase()]
					data[propName] = enumMap[propValue]
					break
				}
				case 'bitmask': {
					const flagMap = constants[propName.toUpperCase()]
					data[propName] = propValue.reduce((mask, flag) => mask | flagMap[flag], 0)
					break
				}
				case 'string': {
					data[propName] = stringInterningTable.intern(propValue)
					break
				}
				case 'flat_array': {
					const { capacity, lengthProperty, itemRepresentation } = rep
					const sourceArray = propValue || []
					const liveLength = Math.min(sourceArray.length, capacity)

					for (let i = 0; i < capacity; i++) {
						const key = `${propName}${i}`
						if (i < liveLength) {
							const value = sourceArray[i]
							switch (itemRepresentation.type) {
								case 'string':
									data[key] = stringInterningTable.intern(value ?? '')
									break
								case 'enum':
									data[key] = itemRepresentation.enumMap[value] ?? 0
									break
								default:
									data[key] = value ?? 0
									break
							}
						} else {
							data[key] = 0 // Fill rest with 0
						}
					}
					data[lengthProperty] = liveLength
					delete data[propName] // Remove the original array property
					break
				}
				case 'rpn': {
					const { RPN_OP, FORMULA_PARSER_CONFIG } = this._getRpnConfig()

					const { streamProperty, startsProperty, lengthsProperty, instanceCapacity } = rep

					const rpnStream = []
					const formulaStarts = []
					const formulaLengths = []
					const liveLength = Math.min(propValue.length, instanceCapacity)

					for (let i = 0; i < liveLength; i++) {
						const formulaString = propValue[i]
						const rpn = formulaString ? compileFormulaToRPN(formulaString, FORMULA_PARSER_CONFIG) : []
						formulaStarts.push(rpn.length > 0 ? rpnStream.length : -1)
						formulaLengths.push(rpn.length)
						rpnStream.push(...rpn)
					}

					// Replace the original 'formulas' property with the three new flat_array properties.
					// The main loop will process these new properties automatically.
					data[streamProperty] = rpnStream
					data[startsProperty] = formulaStarts
					data[lengthsProperty] = formulaLengths

					// Add the new keys to the list of keys to process
					propKeys.push(streamProperty, startsProperty, lengthsProperty)
					delete data[propName]
					break
				}
			}
		}
	}

	_getRpnConfig() {
		if (this._rpnConfig) return this._rpnConfig

		const RPN_OP = { PUSH_LITERAL: -1, PUSH_BASE: -2, PUSH_STAT: -3, ADD: -4, SUBTRACT: -5, MULTIPLY: -6, DIVIDE: -7 }
		const STAT_MAP = { STR: 0, DEX: 1, INT: 2, VIT: 3 }

		this._rpnConfig = {
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

		return this._rpnConfig
	}
}

export const componentInterpreter = new ComponentInterpreter()
