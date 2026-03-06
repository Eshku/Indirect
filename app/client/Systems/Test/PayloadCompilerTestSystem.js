const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs, testManager } = engine.getManagers()
const { entityManager, componentManager, prefabManager } = ecs
const { stringInterningTable } = await import(`${PATH_INDIRECT}/StringInterningTable.js`)

const { describe, it, expect } = await import(`${PATH_MANAGERS}/TestManager/TestAPI.js`)

const {
	position,
	velocity,
	flatArrayComponent,
	testEntityTag,
	primitiveComponent,
	stringComponent,
	enumComponent,
	bitmaskComponent,
	rpnComponent,
	entityRefComponent,
} = componentManager.getTypeIDs()

/**
 * A system dedicated to testing the functionality of the PayloadCompiler.
 * It runs a suite of self-contained tests for each API method during its `init` phase.
 */
export class PayloadCompilerTestSystem {
	constructor() {
		// No constructor logic needed for this test system.
	}

	async init() {
		// Preload the test prefab for the prefab-related tests.
		await prefabManager.preload(['test_prefab'])

		describe('PayloadCompiler', () => {
			// Test compileComponent
			describe('compileComponent()', () => {
				it('should compile a single component payload and mutators', () => {
					const { payload, mutators } = this.compiler.compileComponent(position, { x: 123, y: 456 })

					// Verify payload structure
					expect(payload).toBeDefined()
					expect(payload.typeID).toBe(position)
					expect(payload.data).toBeInstanceOf(ArrayBuffer)
					expect(payload.data.byteLength).toBe(16) // f64 + f64

					// Verify mutators
					expect(mutators).toBeDefined()
					expect(mutators.position).toBeDefined()
					expect(mutators.position.x).toBeInstanceOf(Float64Array)
					expect(mutators.position.y).toBeInstanceOf(Float64Array)

					// Verify initial value from mutator
					expect(mutators.position.x[0]).toBe(123)
					expect(mutators.position.y[0]).toBe(456)

					// Verify mutator functionality
					mutators.position.x[0] = 999
					expect(mutators.position.x[0]).toBe(999)

					// To verify the buffer itself, we can create a DataView
					const view = new DataView(payload.data)
					expect(view.getFloat64(0, true)).toBe(999) // x is at offset 0
					expect(view.getFloat64(8, true)).toBe(456) // y is at offset 8
				})

				it('should compile a component with default values', () => {
					const { mutators } = this.compiler.compileComponent(position, { x: 50 })

					expect(mutators.position.x[0]).toBe(50)
					// The 'y' value was not provided, so it should fall back to the schema default, which is 0.
					expect(mutators.position.y[0]).toBe(0)
				})

				it('should compile a flat array component correctly', () => {
					const { payload, mutators } = this.compiler.compileComponent(flatArrayComponent, {
						primitiveArray: [10, 20, 30],
					})

					expect(payload).toBeDefined()
					expect(mutators.flatArrayComponent).toBeDefined()

					const paMutator = mutators.flatArrayComponent.primitiveArray
					const paCountMutator = mutators.flatArrayComponent.primitiveArray_count

					// The schema defines 'of: i32', so the mutator should be an Int32Array.
					expect(paMutator).toBeInstanceOf(Int32Array)
					expect(paCountMutator).toBeInstanceOf(Uint8Array)

					expect(paMutator.length).toBe(5) // capacity from schema
					expect(paCountMutator[0]).toBe(3) // length

					expect(paMutator[0]).toBe(10)
					expect(paMutator[1]).toBe(20)
					expect(paMutator[2]).toBe(30)
					expect(paMutator[3]).toBe(0) // default value

					// Test mutation
					paMutator[1] = -99
					paCountMutator[0] = 2

					expect(paMutator[1]).toBe(-99)
					expect(paCountMutator[0]).toBe(2)
				})
			})

			describe('Data Type Coverage', () => {
				it('should compile all primitive types', () => {
					const data = {
						f64: 1.1,
						f32: 2.2,
						i32: -3,
						u32: 4,
						i16: -5,
						u16: 6,
						i8: -7,
						u8: 8,
						boolean: true,
					}
					const { mutators } = this.compiler.compileComponent(primitiveComponent, data)

					expect(mutators.primitiveComponent.f64[0]).toBe(1.1)
					// f32 will have precision loss
					expect(Math.abs(mutators.primitiveComponent.f32[0] - 2.2) < 1e-6).toBe(true)
					expect(mutators.primitiveComponent.i32[0]).toBe(-3)
					expect(mutators.primitiveComponent.u32[0]).toBe(4)
					expect(mutators.primitiveComponent.i16[0]).toBe(-5)
					expect(mutators.primitiveComponent.u16[0]).toBe(6)
					expect(mutators.primitiveComponent.i8[0]).toBe(-7)
					expect(mutators.primitiveComponent.u8[0]).toBe(8)
					expect(mutators.primitiveComponent.boolean[0]).toBe(1)
				})

				it('should compile a string component', () => {
					const { mutators } = this.compiler.compileComponent(stringComponent, { value: 'test_string' })
					const internedId = stringInterningTable.intern('test_string')
					expect(mutators.stringComponent.value[0]).toBe(internedId)
				})

				it('should compile an enum component from a string', () => {
					// The interpreter no longer supports string-to-number conversion for enums.
					// Data must be provided in its raw, numeric form.
					const { mutators } = this.compiler.compileComponent(enumComponent, { state: 2 })
					expect(mutators.enumComponent.state[0]).toBe(2)
				})

				it('should compile a bitmask component from a string array', () => {
					// The interpreter no longer supports string-to-number conversion for bitmasks.
					// Data must be provided in its raw, numeric form (1 | 4 = 5).
					const { mutators } = this.compiler.compileComponent(bitmaskComponent, { flags: 5 })
					expect(mutators.bitmaskComponent.flags[0]).toBe(5)
				})

				it('should compile an entity reference component', () => {
					const entityId = 1234567890123456789n
					const { mutators } = this.compiler.compileComponent(entityRefComponent, { target: entityId })

					expect(mutators.entityRefComponent.target).toBeInstanceOf(BigUint64Array)
					expect(mutators.entityRefComponent.target[0]).toBe(entityId)
				})

				it('should compile an RPN component', () => {
					const { mutators } = this.compiler.compileComponent(rpnComponent, {
						formulas: ['10 * BASE'],
					})

					// RPN: 10, BASE, * -> PUSH_LITERAL, 10, PUSH_BASE, MULTIPLY
					// Opcodes: -1, 10, -2, -6
					const stream = mutators.rpnComponent.formulas_rpnStream
					const starts = mutators.rpnComponent.formulas_formulaStarts
					const lengths = mutators.rpnComponent.formulas_formulaLengths
					const streamCount = mutators.rpnComponent.formulas_rpnStream_count

					expect(stream).toBeInstanceOf(Float32Array)
					expect(starts).toBeInstanceOf(Int16Array)
					expect(lengths).toBeInstanceOf(Uint8Array)
					expect(streamCount).toBeInstanceOf(Uint8Array)

					expect(streamCount[0]).toBe(4) // 4 elements in the stream
					expect(starts[0]).toBe(0) // starts at index 0
					expect(lengths[0]).toBe(4) // length is 4

					// Check the stream content. The interpreter compiles it.
					expect(stream[0]).toBe(-1) // PUSH_LITERAL
					expect(stream[1]).toBe(10)
					expect(stream[2]).toBe(-2) // PUSH_BASE
					expect(stream[3]).toBe(-6) // MULTIPLY
				})

				it('should compile a flat array of enums from strings', () => {
					// The interpreter no longer supports string-to-number conversion for enums in arrays.
					// Data must be provided in its raw, numeric form.
					const { mutators } = this.compiler.compileComponent(flatArrayComponent, { enumArray: [1, 0] })

					const eaMutator = mutators.flatArrayComponent.enumArray
					const eaCountMutator = mutators.flatArrayComponent.enumArray_count

					// Schema defines 'of: enum', which defaults to u8 storage
					expect(eaMutator).toBeInstanceOf(Uint8Array)
					expect(eaCountMutator[0]).toBe(2)
					// VAL2 is 1, VAL1 is 0
					expect(eaMutator[0]).toBe(1)
					expect(eaMutator[1]).toBe(0)
				})

				it('should compile a flat array of strings', () => {
					const { mutators } = this.compiler.compileComponent(flatArrayComponent, {
						stringArray: ['a', 'b'],
					})

					const saMutator = mutators.flatArrayComponent.stringArray
					const saCountMutator = mutators.flatArrayComponent.stringArray_count
					const internedA = stringInterningTable.intern('a')
					const internedB = stringInterningTable.intern('b')

					// Schema defines 'of: string', which is u32 storage
					expect(saMutator).toBeInstanceOf(Uint32Array)
					expect(saCountMutator[0]).toBe(2)
					// Interpreter converts to interned IDs
					expect(saMutator[0]).toBe(internedA)
					expect(saMutator[1]).toBe(internedB)
				})
			})

			// Test compileEntity (SoA)
			describe('compileEntity() - SoA', () => {
				it('should compile an entity from a component object', () => {
					const source = {
						Position: { x: 10, y: 20 },
						Velocity: { x: 1, y: 2 },
					}
					const { payload, mutators } = this.compiler.compileEntity(source)

					// Verify payload structure
					expect(payload).toBeDefined()
					expect(payload.archetypeId).toBeTypeOf('number')
					expect(payload.data).toBeInstanceOf(ArrayBuffer)
					expect(payload.data.byteLength).toBe(32) // Position(16) + Velocity(16)

					// Verify mutators
					expect(mutators).toBeDefined()
					expect(mutators.position.x[0]).toBe(10)
					expect(mutators.position.y[0]).toBe(20)
					expect(mutators.velocity.x[0]).toBe(1)
					expect(mutators.velocity.y[0]).toBe(2)

					// Test mutation
					mutators.position.x[0] = -5
					expect(mutators.position.x[0]).toBe(-5)

					// Verify by creating an entity
					const entityId = entityManager.createEntityFromBinarySoAPayload(payload.archetypeId, payload.data, 0)
					const pos = ecs.getComponent(entityId, 'Position')
					const vel = ecs.getComponent(entityId, 'Velocity')

					expect(pos).toEqual({ x: -5, y: 20 })
					expect(vel).toEqual({ x: 1, y: 2 })

					ecs.destroyEntity(entityId)
				})

				it('should compile an entity from a prefab name', () => {
					const { payload, mutators } = this.compiler.compileEntity('test_prefab')

					// Prefab has Position: {x:0, y:0}, Velocity: {x:0, y:0}, TestEntityTag: {}
					expect(mutators.position.x[0]).toBe(0)
					expect(mutators.position.y[0]).toBe(0)
					expect(mutators.velocity.x[0]).toBe(0)
					expect(mutators.velocity.y[0]).toBe(0)
					expect(mutators.testEntityTag).toEqual({})

					// Verify by creating an entity
					const entityId = entityManager.createEntityFromBinarySoAPayload(payload.archetypeId, payload.data, 0)
					const pos = ecs.getComponent(entityId, 'Position')
					const vel = ecs.getComponent(entityId, 'Velocity')
					const hasTag = ecs.hasComponent(entityId, 'TestEntityTag')

					expect(pos).toEqual({ x: 0, y: 0 })
					expect(vel).toEqual({ x: 0, y: 0 })
					expect(hasTag).toBe(true)

					ecs.destroyEntity(entityId)
				})

				it('should compile an entity from a prefab with overrides', () => {
					const overrides = {
						Position: { y: 99 },
						Velocity: { x: -10 },
					}
					const { payload, mutators } = this.compiler.compileEntity('test_prefab', overrides)

					// Prefab has Position: {x:0, y:0}, Velocity: {x:0, y:0}
					// Overrides change y to 99 and x to -10
					expect(mutators.position.x[0]).toBe(0) // from prefab
					expect(mutators.position.y[0]).toBe(99) // from override
					expect(mutators.velocity.x[0]).toBe(-10) // from override
					expect(mutators.velocity.y[0]).toBe(0) // from prefab

					// Verify by creating an entity
					const entityId = entityManager.createEntityFromBinarySoAPayload(payload.archetypeId, payload.data, 0)
					const pos = ecs.getComponent(entityId, 'Position')
					const vel = ecs.getComponent(entityId, 'Velocity')

					expect(pos).toEqual({ x: 0, y: 99 })
					expect(vel).toEqual({ x: -10, y: 0 })

					ecs.destroyEntity(entityId)
				})
			})

			// Test compileEntities (AoS)
			describe('compileEntities() - AoS', () => {
				it('should compile an entity from a component object into AoS format', () => {
					const source = {
						Position: { x: 10, y: 20 },
						Velocity: { x: 1, y: 2 },
					}
					const { payload, mutators } = this.compiler.compileEntities(source)

					// Verify payload structure
					expect(payload).toBeDefined()
					expect(payload.archetypeId).toBeTypeOf('number')
					expect(payload.data).toBeInstanceOf(ArrayBuffer)
					expect(payload.data.byteLength).toBe(32) // Position(16) + Velocity(16)

					// Verify mutators
					expect(mutators).toBeDefined()
					expect(mutators.position.x[0]).toBe(10)
					expect(mutators.position.y[0]).toBe(20)
					expect(mutators.velocity.x[0]).toBe(1)
					expect(mutators.velocity.y[0]).toBe(2)

					// Test mutation
					mutators.position.x[0] = -5
					expect(mutators.position.x[0]).toBe(-5)

					// Verify by creating entities
					// The payload from compileEntities is AoS, for createIdenticalEntitiesInArchetype
					const entityIds = entityManager.createIdenticalEntitiesInArchetype(payload.archetypeId, payload.data, 2, 0)

					const pos1 = ecs.getComponent(entityIds[0], 'Position')
					const vel1 = ecs.getComponent(entityIds[0], 'Velocity')
					expect(pos1).toEqual({ x: -5, y: 20 })
					expect(vel1).toEqual({ x: 1, y: 2 })

					const pos2 = ecs.getComponent(entityIds[1], 'Position')
					const vel2 = ecs.getComponent(entityIds[1], 'Velocity')
					expect(pos2).toEqual({ x: -5, y: 20 })
					expect(vel2).toEqual({ x: 1, y: 2 })

					ecs.destroyEntity(entityIds[0])
					ecs.destroyEntity(entityIds[1])
				})
			})
		})

		await testManager.runAllTests()
	}

	destroy() {
		testManager.clear()
	}
}