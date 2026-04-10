const { engine } = await import(`@client/Engine.js`)
const { ecs, testManager } = engine.getManagers()
const { entityManager, componentManager, prefabManager } = ecs
const { stringInterningTable } = await import(`@indirect/StringInterningTable.js`)

const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`)

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
	health,
	prefab,
	shorthandDefaultComponent,
} = componentManager.getTypeIDs()

/**
 * A system dedicated to testing the functionality of the PayloadCompiler.
 * It runs a suite of self-contained tests for each API method during its `init` phase.
 */
export class PayloadCompilerTestSystem {
	constructor() {
		this.systemManager = ecs.systemManager
	}

	async init() {
		// Preload the test prefab for the prefab-related tests.
		await prefabManager.preload(['test_prefab', 'ShorthandDefaultTest.prefab'])

		describe('PayloadCompiler', () => {
/* 			describe('compile(typeID, data) - Single Component Payloads', () => {
				it('should compile a basic component payload', () => {
					const { payload, mutators } = this.compile(position, { x: 123, y: 456 })

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

				it('should apply schema defaults for missing properties', () => {
					const { mutators } = this.compile(position, { x: 50 })

					expect(mutators.position.x[0]).toBe(50)
					// The 'y' value was not provided, so it should fall back to the schema default, which is 0.
					expect(mutators.position.y[0]).toBe(0)
				})
				it('should correctly compile a flat array of primitives', () => {
					const { payload, mutators } = this.compile(flatArrayComponent, {
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

				it('should correctly compile all primitive types', () => {
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
					const { mutators } = this.compile(primitiveComponent, data)

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

				it('should correctly compile a string component', () => {
					const { mutators } = this.compile(stringComponent, { value: 'test_string' })
					const internedId = stringInterningTable.intern('test_string')
					expect(mutators.stringComponent.value[0]).toBe(internedId)
				})

				it('should correctly compile an enum component', () => {
					// The interpreter no longer supports string-to-number conversion for enums.
					// Data must be provided in its raw, numeric form.
					const { mutators } = this.compile(enumComponent, { state: 2 })
					expect(mutators.enumComponent.state[0]).toBe(2)
				})

				it('should correctly compile a bitmask component', () => {
					// The interpreter no longer supports string-to-number conversion for bitmasks.
					// Data must be provided in its raw, numeric form (1 | 4 = 5).
					const { mutators } = this.compile(bitmaskComponent, { flags: 5 })
					expect(mutators.bitmaskComponent.flags[0]).toBe(5)
				})

				it('should correctly compile an entity reference component', () => {
					const entityId = 1234567890123456789n
					const { mutators } = this.compile(entityRefComponent, { target: entityId })

					expect(mutators.entityRefComponent.target).toBeInstanceOf(BigUint64Array)
					expect(mutators.entityRefComponent.target[0]).toBe(entityId)
				})

				it('should correctly compile an RPN component', () => {
					const { mutators } = this.compile(rpnComponent, {
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

				it('should correctly compile a flat array of enums', () => {
					// The interpreter no longer supports string-to-number conversion for enums in arrays.
					// Data must be provided in its raw, numeric form.
					const { mutators } = this.compile(flatArrayComponent, { enumArray: [1, 0] })

					const eaMutator = mutators.flatArrayComponent.enumArray
					const eaCountMutator = mutators.flatArrayComponent.enumArray_count

					// Schema defines 'of: enum', which defaults to u8 storage
					expect(eaMutator).toBeInstanceOf(Uint8Array)
					expect(eaCountMutator[0]).toBe(2)
					// VAL2 is 1, VAL1 is 0
					expect(eaMutator[0]).toBe(1)
					expect(eaMutator[1]).toBe(0)
				})

				it('should correctly compile a flat array of strings', () => {
					const { mutators } = this.compile(flatArrayComponent, {
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

			describe('compile(object | prefab) - Entity Payloads', () => {
				it('should apply defaults when a prefab uses a shorthand', () => {
					const { payload, mutators } = this.compile('ShorthandDefaultTest.prefab')

					// Verify mutators
					expect(mutators.shorthandDefaultComponent).toBeDefined()

					// Check the shorthand value
					expect(mutators.shorthandDefaultComponent.value[0]).toBe(123)

					// Check the default value
					const internedDefaultText = stringInterningTable.intern('default_text')
					expect(mutators.shorthandDefaultComponent.text[0]).toBe(internedDefaultText)

					// Verify by creating an entity
					const entityId = entityManager.createEntityFromAosPayload(payload.archetypeId, payload.data, 0)
					const compData = ecs.getComponent(entityId, 'ShorthandDefaultComponent')

					expect(compData).toBeDefined()
					expect(compData.value).toBe(123)
					expect(compData.text).toBe('default_text')

					ecs.destroyEntity(entityId)
				})

				it('should apply defaults when an object uses a shorthand', () => {
					const { payload, mutators } = this.compile({
						ShorthandDefaultComponent: 456,
					})

					// Verify mutators
					expect(mutators.shorthandDefaultComponent).toBeDefined()

					// Check the shorthand value
					expect(mutators.shorthandDefaultComponent.value[0]).toBe(456)

					// Check the default value
					const internedDefaultText = stringInterningTable.intern('default_text')
					expect(mutators.shorthandDefaultComponent.text[0]).toBe(internedDefaultText)

					// Verify by creating an entity
					const entityId = entityManager.createEntityFromAosPayload(payload.archetypeId, payload.data, 0)
					const compData = ecs.getComponent(entityId, 'ShorthandDefaultComponent')

					expect(compData).toBeDefined()
					expect(compData.value).toBe(456)
					expect(compData.text).toBe('default_text')

					ecs.destroyEntity(entityId)
				})

				it('should compile an entity from a component object', () => {
					const source = {
						Position: { x: 10, y: 20 },
						Velocity: { x: 1, y: 2 },
					}
					const { payload, mutators } = this.compile(source)

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
					const entityId = entityManager.createEntityFromAosPayload(payload.archetypeId, payload.data, 0)
					const pos = ecs.getComponent(entityId, 'Position')
					const vel = ecs.getComponent(entityId, 'Velocity')

					expect(pos).toEqual({ x: -5, y: 20 })
					expect(vel).toEqual({ x: 1, y: 2 })

					ecs.destroyEntity(entityId)
				})

				it('should compile an entity from a prefab name', () => {
					const { payload, mutators } = this.compile('test_prefab')

					// Prefab has Position: {x:0, y:0}, Velocity: {x:0, y:0}, TestEntityTag: {}
					expect(mutators.position.x[0]).toBe(0)
					expect(mutators.position.y[0]).toBe(0)
					expect(mutators.velocity.x[0]).toBe(0)
					expect(mutators.velocity.y[0]).toBe(0)
					expect(mutators.testEntityTag).toEqual({})

					// Verify by creating an entity
					const entityId = entityManager.createEntityFromAosPayload(payload.archetypeId, payload.data, 0)
					const pos = ecs.getComponent(entityId, 'Position')
					const vel = ecs.getComponent(entityId, 'Velocity')
					const hasTag = ecs.hasComponent(entityId, 'TestEntityTag')

					expect(pos).toEqual({ x: 0, y: 0 })
					expect(vel).toEqual({ x: 0, y: 0 })
					expect(hasTag).toBe(true)

					ecs.destroyEntity(entityId)
				})

				it('should compile an entity from a prefab with object overrides', () => {
					const overrides = {
						Position: { y: 99 },
						Velocity: { x: -10 },
					}
					const { payload, mutators } = this.compile('test_prefab', overrides)

					// Prefab has Position: {x:0, y:0}, Velocity: {x:0, y:0}
					// Overrides change y to 99 and x to -10
					expect(mutators.position.x[0]).toBe(0) // from prefab
					expect(mutators.position.y[0]).toBe(99) // from override
					expect(mutators.velocity.x[0]).toBe(-10) // from override
					expect(mutators.velocity.y[0]).toBe(0) // from prefab

					// Verify by creating an entity
					const entityId = entityManager.createEntityFromAosPayload(payload.archetypeId, payload.data, 0)
					const pos = ecs.getComponent(entityId, 'Position')
					const vel = ecs.getComponent(entityId, 'Velocity')

					expect(pos).toEqual({ x: 0, y: 99 })
					expect(vel).toEqual({ x: -10, y: 0 })

					ecs.destroyEntity(entityId)
				})
				it('should correctly apply a shorthand override on a prefab', () => {
					const { payload, mutators } = this.compile('ShorthandDefaultTest.prefab', {
						ShorthandDefaultComponent: 999,
					})

					// Check the shorthand value from the override
					expect(mutators.shorthandDefaultComponent.value[0]).toBe(999)

					// Check the default value (which should still be applied)
					const internedDefaultText = stringInterningTable.intern('default_text')
					expect(mutators.shorthandDefaultComponent.text[0]).toBe(internedDefaultText)

					const entityId = entityManager.createEntityFromAosPayload(payload.archetypeId, payload.data, 0)
					const compData = ecs.getComponent(entityId, 'ShorthandDefaultComponent')
					expect(compData).toEqual({ value: 999, text: 'default_text' })
					ecs.destroyEntity(entityId)
				})
			})

			describe('Integration with ECS.instantiate()', () => {
				it('should correctly apply a shorthand override during immediate-mode instantiation', () => {
					const entityId = ecs.instantiate('ShorthandDefaultTest.prefab', {
						ShorthandDefaultComponent: 999,
					})

					expect(entityId).toBeDefined()
					const compData = ecs.getComponent(entityId, 'ShorthandDefaultComponent')
					expect(compData).toEqual({ value: 999, text: 'default_text' })

					// Cleanup
					ecs.destroyEntity(entityId)
				})

				it('should correctly apply a partial object override during immediate-mode instantiation', () => {
					const entityId = ecs.instantiate('ShorthandDefaultTest.prefab', {
						ShorthandDefaultComponent: { text: 'overridden text' },
					})

					expect(entityId).toBeDefined()
					const compData = ecs.getComponent(entityId, 'ShorthandDefaultComponent')
					expect(compData).toEqual({ value: 123, text: 'overridden text' })

					// Cleanup
					ecs.destroyEntity(entityId)
				})
			})

			describe('Dirty Tracking Metadata', () => {
				it('should include trackableComponentIds for multi-component payloads', () => {
					// health is trackable, position is not.
					const source = {
						health: { current: 50 },
						position: { x: 10, y: 20 },
					}
					const { payload } = this.compile(source)

					expect(payload.trackableComponentIds).toBeDefined()
					expect(payload.trackableComponentIds).toBeInstanceOf(Array)
					expect(payload.trackableComponentIds).toEqual([health])

				})

				it('should include trackableComponentIds for single-component payloads (trackable)', () => {
					const { payload } = this.compile(health, { current: 50 })

					expect(payload.trackableComponentIds).toBeDefined()
					expect(payload.trackableComponentIds).toEqual([health])
				})

				it('should include an empty trackableComponentIds for single-component payloads (not trackable)', () => {
					const { payload } = this.compile(position, { x: 10 })

					expect(payload.trackableComponentIds).toBeDefined()
					expect(payload.trackableComponentIds).toEqual([])
				})

				it('should include an empty trackableComponentIds when no components are trackable', () => {
					const source = {
						position: { x: 10 },
						velocity: { x: 1 },
					}
					const { payload } = this.compile(source)

					expect(payload.trackableComponentIds).toBeDefined()
					expect(payload.trackableComponentIds).toEqual([])
				})
			}) */

			describe('compileDefaults() - Pooling Resets', () => {
				it('should compile a defaults payload from a prefab, applying overrides and ignores', () => {
					// The 'test_prefab' has Position {x:0, y:0}, Velocity {x:0, y:0}, TestEntityTag
					// The schema for Health has a default of { current: 100, max: 100 }
					const { payload, mutators } = this.compileDefaults(
						'test_prefab',
						{
							// Override the default for position
							position: { x: 50, y: 50 },
						},
						[
							// Ignore the Velocity component by its ID
							velocity,
						],
					)

					// 1. Verify Archetype & Size
					// The resulting payload should contain Position and TestEntityTag.
					const expectedArchetype = entityManager.getArchetype([position, testEntityTag])
					expect(payload.archetypeId).toBe(expectedArchetype)
					// Position (16 bytes) + TestEntityTag (0 bytes). Prefab component should be ignored.
					expect(payload.data.byteLength).toBe(16)

					// 2. Verify Mutators and Values
					expect(mutators.position).toBeDefined()
					expect(mutators.velocity).toBeUndefined() // Should be ignored
					expect(mutators.testEntityTag).toBeDefined()

					// Check the overridden value
					expect(mutators.position.x[0]).toBe(50)
					expect(mutators.position.y[0]).toBe(50)

					// 3. Verify on a real entity (via command buffer)
					const entityId = ecs.createEntity({
						position: { x: 999, y: 999 },
						velocity: { x: 1, y: 1 },
						testEntityTag: {},
					})

					this.setComponents(entityId, payload)
					this.flush()

					const pos = ecs.getComponent(entityId, 'position')
					const vel = ecs.getComponent(entityId, 'velocity')

					// Position should be reset to the overridden default
					expect(pos).toEqual({ x: 50, y: 50 })
					// Velocity should be untouched because it was ignored
					expect(vel).toEqual({ x: 1, y: 1 })

					ecs.destroyEntity(entityId)
				})

				it('should compile a defaults payload from a component object', () => {
					// Schemas: Position defaults to {x:0, y:0}, Health to {current:100, max:100}
					const sourceObject = {
						position: {},
						health: {},
					}

					const { payload } = this.compileDefaults(sourceObject)

					// Verify Archetype & Size
					const expectedArchetype = entityManager.getArchetype([position, health])
					expect(payload.archetypeId).toBe(expectedArchetype)
					expect(payload.data.byteLength).toBe(24) // Position (16) + Health (8)
				})
			})
		})

		await testManager.runAllTests()
	}

	destroy() {
		testManager.clear()
	}
}
