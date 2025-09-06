const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { componentManager } = theManager.getManagers()
const { ECS } = await import(`${PATH_CORE}/ECS/ECS.js`)
const { testManager } = await import(`${PATH_CLIENT}/Managers/TestManager/TestManager.js`)
const { describe, it, expect } = await import(`${PATH_CLIENT}/Managers/TestManager/TestAPI.js`)

const { PrimitiveComponent, StringComponent, EnumComponent, BitmaskComponent, FlatArrayComponent, RpnComponent } =
	componentManager.getComponents()

/**
 * A system dedicated to testing the functionality of the SchemaParser and data layer.
 * It runs a suite of self-contained tests for each schema type during its `init` phase.
 */
export class SchemaTestSystem {
	constructor() {
		this.testConfig = {
			primitiveTypes: false,
			internedStrings: false,
			enums: false,
			bitmasks: false,
			flatArrayPrimitives: true,
			flatArrayEnums: true,
			flatArrayStrings: true,
			flatArrayPartial: true,
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
					const retrievedData = ECS.getComponent(entityId, PrimitiveComponent)

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
					const retrievedData = ECS.getComponent(entityId, StringComponent)

					expect(retrievedData.value).toBe('hello_world')

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.enums) {
				it('should correctly store and retrieve enum values', () => {
					const initialData = { state: 'JUMPING' }
					const entityId = ECS.createEntity({ EnumComponent: initialData })
					const retrievedData = ECS.getComponent(entityId, EnumComponent)

					expect(retrievedData.state).toBe('JUMPING')

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.bitmasks) {
				it('should correctly store and retrieve bitmask values', () => {
					const initialData = { flags: ['FLAG_A', 'FLAG_C'] }
					const entityId = ECS.createEntity({ BitmaskComponent: initialData })
					const retrievedData = ECS.getComponent(entityId, BitmaskComponent)

					// The order of flags is not guaranteed, so sort both arrays to ensure
					// the content is identical before comparing.
					const expectedFlags = ['FLAG_A', 'FLAG_C'].sort()
					const actualFlags = retrievedData.flags.sort()
					expect(actualFlags).toEqual(expectedFlags)
					expect(retrievedData.flags.length).toBe(2)

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.flatArrayPrimitives) {
				it('should correctly store and retrieve a flat array of primitives', () => {
					const initialData = {
						primitiveArray: [10, -20, 30],
					}
					const entityId = ECS.createEntity({ FlatArrayComponent: initialData })
					const retrievedData = ECS.getComponent(entityId, FlatArrayComponent)

					expect(retrievedData.primitiveArray).toEqual([10, -20, 30])
					// Ensure other arrays in the component are empty
					expect(retrievedData.enumArray).toEqual([])
					expect(retrievedData.stringArray).toEqual([])

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.flatArrayEnums) {
				it('should correctly store and retrieve a flat array of enums', () => {
					const initialData = {
						enumArray: ['VAL2', 'VAL1'],
					}
					const entityId = ECS.createEntity({ FlatArrayComponent: initialData })
					const retrievedData = ECS.getComponent(entityId, FlatArrayComponent)

					expect(retrievedData.enumArray).toEqual(['VAL2', 'VAL1'])
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
					const retrievedData = ECS.getComponent(entityId, FlatArrayComponent)

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
					const retrievedData = ECS.getComponent(entityId, FlatArrayComponent)

					expect(retrievedData.primitiveArray).toEqual([5])
					expect(retrievedData.enumArray).toEqual([])
					expect(retrievedData.stringArray).toEqual(['one', 'two'])

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.rpn) {
				it('should correctly process and store an RPN formula', () => {
					const initialData = {
						formulas: ['10 * BASE + 5'],
					}
					const entityId = ECS.createEntity({ RpnComponent: initialData })

					const retrievedData = ECS.getComponent(entityId, RpnComponent)

					// The 'read' path for RPN is not fully implemented to reconstruct the original formula.
					// Instead, we verify that the underlying flattened properties are present,
					// which confirms that the 'write' path processing was successful.
					expect(retrievedData).toBeDefined()
					expect(retrievedData.formulas).toBe(undefined) // Original property is gone.
					expect(retrievedData).toHaveProperty('formulas_rpnStream_count')
					expect(retrievedData).toHaveProperty('formulas_formulaStarts_count')
					expect(retrievedData).toHaveProperty('formulas_formulaLengths_count')

					// '10 * BASE + 5' -> PUSH_LITERAL, 10, PUSH_BASE, MULTIPLY, PUSH_LITERAL, 5, ADD
					// RPN stream length is 7.
					expect(retrievedData.formulas_rpnStream_count).toBe(7)
					// One formula was provided, so the starts/lengths arrays should have a count of 1.
					expect(retrievedData.formulas_formulaStarts_count).toBe(1)
					expect(retrievedData.formulas_formulaLengths_count).toBe(1)

					ECS.destroyEntity(entityId)
				})
			}
		})

		// Run all the defined tests.
		testManager.runAllTests()
	}
}
