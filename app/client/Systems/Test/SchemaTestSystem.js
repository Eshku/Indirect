const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const { componentManager } = ecs

const { testManager } = await import(`@client/Managers/TestManager/TestManager.js`)
const { describe, it, expect } = await import(`@client/Managers/TestManager/TestAPI.js`)

/**
 * A system dedicated to testing the functionality of the SchemaParser and data layer.
 * It runs a suite of self-contained tests for each schema type during its `init` phase.
 */
export class SchemaTestSystem {
	constructor() {
		const {
			primitiveComponent: primitiveComponentID,
			stringComponent: stringComponentID,
			enumComponent: enumComponentID,
			bitmaskComponent: bitmaskComponentID,
			flatArrayComponent: flatArrayComponentID,
			rpnComponent: rpnComponentID,
			componentRefComponent: componentRefComponentID,
			entityRefArrayComponent: entityRefArrayComponentID,
		} = componentManager.getTypeIDs()

		// Get the canonical string names for the high-level ECS API.
		const componentNames = Object.keys(componentManager.getTypeIDs())
		this.testConfig = {
			primitiveTypes: true,
			internedStrings: true,
			enums: true,
			enumConstants: true,
			bitmasks: true,
			bitmaskConstants: true,
			flatArrayPrimitives: true,
			flatArrayEnums: true,
			flatArrayStrings: true,
			flatArrayPartial: true,
			flatArrayEntities: true,
			componentRef: true,
			rpn: true,
		}
	}

	async init() {
		describe('Component Schema System', () => {
			if (this.testConfig.primitiveTypes) {
				it('should correctly store and retrieve all primitive types', () => {
					const initialData = {
						f64: 1.23456789,
						f32: 9.876,
						i32: -123456,
						u32: 123456,
						i16: -1234,
						u16: 1234,
						i8: -12,
						u8: 12,
						boolean: true,
					}
					const entityId = ECS.createEntity({ PrimitiveComponent: initialData })

					const retrievedData = ECS.getComponent(entityId, 'PrimitiveComponent')

					// f32 has precision limitations, so we check it with a tolerance.
					expect(retrievedData.f32).not.toBe(initialData.f32) // It won't be exact
					expect(Math.abs(retrievedData.f32 - initialData.f32) < 1e-6).toBe(true)

					// Check other primitives for exact matches
					expect(retrievedData.f64).toBe(initialData.f64)
					expect(retrievedData.i32).toBe(initialData.i32)
					expect(retrievedData.u32).toBe(initialData.u32)
					expect(retrievedData.i16).toBe(initialData.i16)
					expect(retrievedData.u16).toBe(initialData.u16)
					expect(retrievedData.i8).toBe(initialData.i8)
					expect(retrievedData.u8).toBe(initialData.u8)
					expect(retrievedData.boolean).toBe(1) // Booleans are stored as 1/0

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.internedStrings) {
				it('should correctly store and retrieve interned strings', () => {
					const initialData = { value: 'hello_world' }
					const entityId = ECS.createEntity({ StringComponent: initialData })

					const retrievedData = ECS.getComponent(entityId, 'StringComponent')

					expect(retrievedData.value).toBe('hello_world')

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.enums) {
				it('should correctly store and retrieve enum values', () => {
					const stateConstants = componentManager.getConstantsForProperty('EnumComponent', 'state')
					const initialData = { state: stateConstants.JUMPING } // Use numeric value
					const entityId = ECS.createEntity({ EnumComponent: initialData })

					const retrievedData = ECS.getComponent(entityId, 'EnumComponent')

					// The component now returns the raw numeric value.
					expect(retrievedData.state).toBe(stateConstants.JUMPING)

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.enumConstants) {
				it('should correctly retrieve enum constants via the ComponentManager', () => {
					const stateConstants = componentManager.getConstantsForProperty('EnumComponent', 'state')
					expect(stateConstants).toBeDefined()
					expect(stateConstants).toEqual({ IDLE: 0, RUNNING: 1, JUMPING: 2 })
				})
			}

			if (this.testConfig.bitmasks) {
				it('should correctly store and retrieve bitmask values', () => {
					const flagConstants = componentManager.getConstantsForProperty('BitmaskComponent', 'flags')
					const initialData = { flags: flagConstants.FLAG_A | flagConstants.FLAG_C } // Use numeric value
					const entityId = ECS.createEntity({ BitmaskComponent: initialData })

					const retrievedData = ECS.getComponent(entityId, 'BitmaskComponent')

					// The component now returns the raw numeric bitmask.
					const expectedFlags = flagConstants.FLAG_A | flagConstants.FLAG_C
					expect(retrievedData.flags).toBe(expectedFlags)

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.bitmaskConstants) {
				it('should correctly retrieve bitmask constants via the ComponentManager', () => {
					const flagConstants = componentManager.getConstantsForProperty('BitmaskComponent', 'flags')
					expect(flagConstants).toBeDefined()
					expect(flagConstants).toEqual({ FLAG_A: 1, FLAG_B: 2, FLAG_C: 4, FLAG_D: 8 })
				})
			}

			if (this.testConfig.flatArrayPrimitives) {
				it('should correctly store and retrieve a flat array of primitives', () => {
					const initialData = {
						primitiveArray: [10, -20, 30],
					}
					const entityId = ECS.createEntity({ FlatArrayComponent: initialData })

					const retrievedData = ECS.getComponent(entityId, 'FlatArrayComponent')

					expect(retrievedData.primitiveArray).toEqual([10, -20, 30])
					// Ensure other arrays in the component are empty
					expect(retrievedData.enumArray).toEqual([])
					expect(retrievedData.stringArray).toEqual([])

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.flatArrayEnums) {
				it('should correctly store and retrieve a flat array of enums', () => {
					const enumArrayConstants = componentManager.getConstantsForProperty('FlatArrayComponent', 'enumArray')
					const initialData = {
						enumArray: [enumArrayConstants.VAL2, enumArrayConstants.VAL1], // Use numeric values
					}
					const entityId = ECS.createEntity({ FlatArrayComponent: initialData })
					const retrievedData = ECS.getComponent(entityId, 'FlatArrayComponent')

					// The component now returns raw numeric values in the array.
					expect(retrievedData.enumArray).toEqual([enumArrayConstants.VAL2, enumArrayConstants.VAL1])
					expect(retrievedData.primitiveArray).toEqual([])
					expect(retrievedData.stringArray).toEqual([])

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.flatArrayStrings) {
				it('should correctly store and retrieve a flat array of strings', () => {
					const initialData = {
						stringArray: ['first', 'second', 'third'],
					}
					const entityId = ECS.createEntity({ FlatArrayComponent: initialData })
					const retrievedData = ECS.getComponent(entityId, 'FlatArrayComponent')

					expect(retrievedData.stringArray).toEqual(['first', 'second', 'third'])
					expect(retrievedData.primitiveArray).toEqual([])
					expect(retrievedData.enumArray).toEqual([])

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.flatArrayPartial) {
				it('should correctly handle empty and partial flat arrays', () => {
					const initialData = {
						primitiveArray: [5],
						enumArray: [],
						stringArray: ['one', 'two'],
					}
					const entityId = ECS.createEntity({ FlatArrayComponent: initialData })
					const retrievedData = ECS.getComponent(entityId, 'FlatArrayComponent')

					expect(retrievedData.primitiveArray).toEqual([5])
					expect(retrievedData.enumArray).toEqual([])
					expect(retrievedData.stringArray).toEqual(['one', 'two'])

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.flatArrayEntities) {
				it('should correctly store and retrieve a flat array of entity references', () => {
					const e1 = ECS.createEntity()
					const e2 = ECS.createEntity()

					const initialData = {
						targets: [e1, e2],
					}
					const entityId = ECS.createEntity({ EntityRefArrayComponent: initialData })
					const retrievedData = ECS.getComponent(entityId, 'EntityRefArrayComponent')

					expect(retrievedData.targets).toEqual([e1, e2])

					ECS.destroyEntity(e1)
					ECS.destroyEntity(e2)
					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.componentRef) {
				it('should correctly store and retrieve component references', () => {
					// This test assumes a `ComponentRefComponent` with `{ ref: { type: 'component' } }` is defined.
					const initialData = { ref: 'position' } // Use string name
					const entityId = ECS.createEntity({ ComponentRefComponent: initialData })

					const retrievedData = ECS.getComponent(entityId, 'ComponentRefComponent')

					// Add a check to ensure the component was retrieved before accessing its properties.
					// This will give a more informative test failure message.
					expect(retrievedData).toBeDefined()

					// The `reconstruct` function (called by getComponent) should convert the stored typeID back to its string name.
					expect(retrievedData.ref).toBe('position')

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.rpn) {
				it('should correctly process and store an RPN formula', () => {
					const initialData = {
						formulas: ['10 * BASE + 5'],
					}
					const entityId = ECS.createEntity({ RpnComponent: initialData })

					const retrievedData = ECS.getComponent(entityId, 'RpnComponent')

					// The 'read' path for RPN reconstructs the underlying flat arrays.
					// We verify their existence and content.
					expect(retrievedData).toBeDefined()
					expect(retrievedData.formulas).toBe(undefined) // Original property is gone.

					// Check for the reconstructed arrays
					expect(retrievedData).toHaveProperty('formulas_rpnStream')
					expect(retrievedData).toHaveProperty('formulas_formulaStarts')
					expect(retrievedData).toHaveProperty('formulas_formulaLengths')

					// '10 * BASE + 5' -> PUSH_LITERAL, 10, PUSH_BASE, MULTIPLY, PUSH_LITERAL, 5, ADD
					// RPN stream length is 7.
					expect(retrievedData.formulas_rpnStream.length).toBe(7)
					// One formula was provided, so the starts/lengths arrays should have a count of 1.
					expect(retrievedData.formulas_formulaStarts.length).toBe(1)
					expect(retrievedData.formulas_formulaLengths.length).toBe(1)

					ECS.destroyEntity(entityId)
				})
			}
		})

		// Run all the defined tests.
		testManager.runAllTests()
	}

	destroy() {
		// On HMR, clear the previously registered tests from the TestManager
		// to prevent duplicate test execution.
		testManager.clear()
	}
}
