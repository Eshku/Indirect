/**
 * @fileoverview A central processor for reading and writing component data.
 */

/*
 *
 * This registry maps a type name (from a component's `static schema`)
 * to a function that handles the transformation of raw, designer-friendly data
 * into the engine's "hot", runtime-optimized format.
 *
 * These processors are **generic, runtime, and context-free**. They are used for
 * all entity creations (dynamic or from prefabs, *after* any prefab-specific processing).
 */

//! experimental

//! Component processing adds overhead to entity creation \ component additions.

//! Idea - pre-compile prefabs to use low-level data(kinda, doubt it will be fully low-level, but shortcuts can be made)
//! allow creation of new "prefabs" at runtime - add method which could save a new prefab as low-level reusable data (not as file, just cache).
//! That will help with performance a bit, but wouldn't fully solve the issue.

//! For overrides: entityManager.instantiate('Player', { Health: { current: 50 } }), the process would be:

//! Load the pre-compiled, low-level data for the 'Player' prefab.
//! Take the overrides object ({ Health: { current: 50 } }).
//! Run the ComponentProcessor only on the Health component data from the override.
//! Merge the processed override data into the low-level prefab data.

//! similar thing for addComponent.


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

export class ComponentProcessor {
	constructor(componentManager) {
		this.componentManager = componentManager
		this.typeRegistry = this.createTypeRegistry()
	}

	createTypeRegistry() {
		return Object.freeze({
			enum: (data, propName, propSchema, componentName) => {
				const enumString = data[propName]
				if (enumString === undefined || typeof enumString === 'number') {
					return
				}

				const { values } = propSchema
				const index = values.indexOf(enumString)
				if (index === -1) {
					throw new Error(
						`Invalid enum value "${enumString}" for property "${propName}" in component "${componentName}". ` +
							`Valid values are: [${values.join(', ')}]`
					)
				}
				data[propName] = index
			},

			bitmask: (data, propName, propSchema, componentName) => {
				const flagStrings = data[propName]
				if (flagStrings === undefined || typeof flagStrings === 'number') {
					return
				}

				if (!Array.isArray(flagStrings)) {
					throw new Error(
						`Invalid bitmask value for property "${propName}" in component "${componentName}". Expected an array of strings, but got ${typeof flagStrings}.`
					)
				}

				const { values } = propSchema
				let bitmask = 0
				for (const flagString of flagStrings) {
					const index = values.indexOf(flagString)
					if (index === -1) {
						throw new Error(
							`Invalid bitmask flag "${flagString}" for property "${propName}" in component "${componentName}". ` +
								`Valid flags are: [${values.join(', ')}]`
						)
					}
					bitmask |= 1 << index
				}
				data[propName] = bitmask
			},

			string: (data, propName) => {
				const stringValue = data[propName]

				if (stringValue === undefined || typeof stringValue === 'number') {
					return
				}
				data[propName] = this.componentManager.stringManager.intern(stringValue ?? '')
			},

			flat_array: (data, propName, propSchema) => {
				const sourceArray = data[propName]
				if (sourceArray === undefined) {
					return
				}

				let itemProcessor = value => value

				const itemSchemaDef = propSchema.of
				const itemType = typeof itemSchemaDef === 'string' ? itemSchemaDef : itemSchemaDef.type
				const { itemRepresentation } = propSchema

				if (itemType === 'string') {
					itemProcessor = value => {
						if (typeof value === 'number') {
							console.warn(
								`ComponentProcessor: Attempting to process a number (${value}) as a string in an array. This might be an already-interned string ID, or a data error.`
							)
							return value
						}

						const internedId = this.componentManager.stringManager.intern(value ?? '')
						if (internedId === undefined || internedId === null) {
							console.error(
								`ComponentProcessor: StringManager.intern() returned '${internedId}' for string: "${value}". This will result in a value of 0 in the component buffer.`
							)
							return 0
						}
						return internedId
					}
				} else if (itemType === 'enum') {
					const { enumMap } = itemRepresentation
					if (!enumMap) {
						throw new Error(`ComponentProcessor: Missing enumMap for array of enums "${propName}".`)
					}
					itemProcessor = value => {
						if (typeof value === 'number') {
							return value
						}
						const index = enumMap[value]
						if (index === undefined) {
							throw new Error(`Invalid enum value "${value}" in array for property "${propName}".`)
						}
						return index
					}
				}

				this._flattenArrayIntoData(
					data,
					sourceArray,
					propName,
					propSchema.capacity,
					propSchema.lengthProperty,
					itemProcessor
				)
				delete data[propName]
			},

			rpn: (data, propName, propSchema) => {
				const sourceFormulas = data[propName]
				if (sourceFormulas === undefined) {
					return
				}

				if (!Array.isArray(sourceFormulas)) {
					throw new Error(`RPN property "${propName}" must be an array of formula strings.`)
				}

				const {
					streamProperty,
					startsProperty,
					lengthsProperty,
					instanceCapacity,
					streamCapacity,
					streamLengthProperty,
				} = propSchema

				const rpnStream = []
				const formulaStarts = []
				const formulaLengths = []

				const liveLength = Math.min(sourceFormulas.length, instanceCapacity)

				for (let i = 0; i < liveLength; i++) {
					const formulaString = sourceFormulas[i]
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

				this._flattenArrayIntoData(
					data,
					rpnStream,
					streamProperty,
					streamCapacity,
					streamLengthProperty
				)

				this._flattenArrayIntoData(
					data,
					formulaStarts,
					startsProperty,
					instanceCapacity,
					`${startsProperty}_count`
				)
				this._flattenArrayIntoData(
					data,
					formulaLengths,
					lengthsProperty,
					instanceCapacity,
					`${lengthsProperty}_count`
				)

				delete data[propName]
			},
		})
	}

	_flattenArrayIntoData(data, sourceArray, basePropName, capacity, lengthProperty, itemProcessor = v => v) {
		const liveLength = Math.min(sourceArray.length, capacity)

		for (let i = 0; i < capacity; i++) {
			const key = `${basePropName}${i}`
			if (i < liveLength) {
				data[key] = itemProcessor(sourceArray[i])
			} else {
				data[key] = 0
			}
		}
		data[lengthProperty] = liveLength
	}

	read(entityId, componentTypeId, archetype) {
		const archetypeManager = this.componentManager.archetypeManager
		const location = archetypeManager.archetypeEntityMaps[archetype]?.get(entityId)
		if (!location || !archetypeManager.hasComponentType(archetype, componentTypeId)) {
			return undefined
		}

		const { chunk, indexInChunk } = location
		const componentData = {}
		const info = this.componentManager.componentInfo[componentTypeId]

		for (const propName of info.originalSchemaKeys) {
			const rep = info.representations[propName]
		if (!rep) continue;

		// If the original property was shared, it does not exist in the per-entity
		// component arrays. Its data is in the SharedGroupManager. We skip it here,
		// and read the 'groupId' property after the loop.
		if (rep.shared) {
			continue;
		}

			const componentArrays = chunk.componentArrays[componentTypeId]
		
			if (rep.type === 'rpn') {
				const rpnData = {}
				const streamLength = componentArrays[rep.streamLengthProperty][indexInChunk]
				rpnData.rpnStream = new Array(streamLength)
				for (let i = 0; i < streamLength; i++) {
					rpnData.rpnStream[i] = componentArrays[`${rep.streamProperty}${i}`][indexInChunk]
				}

				const startsLength = componentArrays[`${rep.startsProperty}_count`][indexInChunk]
				rpnData.formulaStarts = new Array(startsLength)
				for (let i = 0; i < startsLength; i++) {
					rpnData.formulaStarts[i] = componentArrays[`${rep.startsProperty}${i}`][indexInChunk]
				}

				const lengthsLength = componentArrays[`${rep.lengthsProperty}_count`][indexInChunk]
				rpnData.formulaLengths = new Array(lengthsLength)
				for (let i = 0; i < lengthsLength; i++) {
					rpnData.formulaLengths[i] = componentArrays[`${rep.lengthsProperty}${i}`][indexInChunk]
				}

				componentData[propName] = rpnData
			} else if (rep.type === 'flat_array') {
				const sourceArray = []
				const len = componentArrays[rep.lengthProperty][indexInChunk]
				const itemRep = rep.itemRepresentation
				for (let i = 0; i < len; i++) {
					const flattenedKey = `${propName}${i}`
					const rawValue = componentArrays[flattenedKey][indexInChunk]

					if (itemRep.type === 'string') {
						sourceArray.push(this.componentManager.stringManager.get(rawValue))
					} else if (itemRep.type === 'enum') {
						sourceArray.push(itemRep.valueMap[rawValue])
					} else {
						sourceArray.push(rawValue)
					}
				}
				componentData[propName] = sourceArray
			} else if (rep.type === 'enum') {
				const rawValue = componentArrays[propName][indexInChunk]
				componentData[propName] = rep.valueMap[rawValue]
			} else if (rep.type === 'bitmask') {
				const rawValue = componentArrays[propName][indexInChunk]
				const flags = []
				for (const flagName in rep.flagMap) {
					if ((rawValue & rep.flagMap[flagName]) !== 0) {
						flags.push(flagName)
					}
				}
				componentData[propName] = flags
			} else if (rep.type === 'string') {
				const rawValue = componentArrays[propName][indexInChunk]
				componentData[propName] = this.componentManager.stringManager.get(rawValue)
			} else {
				if (componentArrays && componentArrays[propName]) {
					componentData[propName] = componentArrays[propName][indexInChunk]
				}
			}
		}

		// After processing all per-entity properties, check if this component type
		// has any shared properties. If so, read the groupId from the storage.
		if (info.sharedProperties.length > 0) {
			const componentArrays = chunk.componentArrays[componentTypeId];
			if (componentArrays && componentArrays.groupId) {
				componentData.groupId = componentArrays.groupId[indexInChunk];
			}
		}
		return componentData;
	}
}
