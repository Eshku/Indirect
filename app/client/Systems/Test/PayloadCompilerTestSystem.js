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
} = ecs.getComponentIDs()

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
			describe('compile({ component: data }) - Single Component Payloads', () => {
				it('should compile a basic component payload and create an entity with it', () => {
					const payload = this.compile({ position: { x: 123, y: 456 }, testEntityTag: {} })

					// Verify payload structure
					expect(payload).toBeDefined()
					const expectedArchetype = entityManager.getArchetype([position, testEntityTag])
					expect(payload.archetypeId).toBe(expectedArchetype)
					expect(payload.capacity).toBe(1)
					expect(payload.buffers).toBeDefined()

					// Verify buffers
					expect(payload.buffers.position).toBeDefined()
					expect(payload.buffers.position.x).toBeInstanceOf(Float64Array)
					expect(payload.buffers.position.y).toBeInstanceOf(Float64Array)

					// Verify initial value from buffer
					expect(payload.buffers.position.x[0]).toBe(123)
					expect(payload.buffers.position.y[0]).toBe(456)

					// Verify buffer mutability before creating the entity
					payload.buffers.position.x[0] = 999
					expect(payload.buffers.position.x[0]).toBe(999)

					// Verify by creating an entity and checking its state after flush
					this.instantiate(payload, 1)
					ecs.executeCommandBuffer() // Use the immediate-mode flush for tests

					const query = this.getQuery({ with: [position, testEntityTag] })
					const entityId = query.getSingleEntity()
					expect(entityId).toBeDefined()

					const pos = ecs.getComponent(entityId, 'position')

					expect(pos.x).toBe(999)
					expect(pos.y).toBe(456)

					ecs.destroyEntity(entityId)
					ecs.executeCommandBuffer()
				})

				it('should apply schema defaults for missing properties', () => {
					const payload = this.compile({ position: { x: 50 } })

					expect(payload.buffers.position.x[0]).toBe(50)
					// The 'y' value was not provided, so it should fall back to the schema default, which is 0.
					expect(payload.buffers.position.y[0]).toBe(0)
				})
				it('should correctly compile a flat array of primitives', () => {
					const payload = this.compile({
						flatArrayComponent: { primitiveArray: [10, -20, 30] },
					})

					expect(payload.buffers.flatArrayComponent).toBeDefined()

					// The `flat_array` is unrolled into individual properties in the payload.
					// We access them directly.
					const pa0 = payload.buffers.flatArrayComponent.primitiveArray0
					const pa1 = payload.buffers.flatArrayComponent.primitiveArray1
					const paCount = payload.buffers.flatArrayComponent.primitiveArray_count

					// The schema defines 'of: i32', so the buffers should be Int32Array.
					expect(pa0).toBeInstanceOf(Int32Array)
					expect(pa1).toBeInstanceOf(Int32Array)
					expect(paCount).toBeInstanceOf(Uint8Array)

					expect(paCount[0]).toBe(3) // length

					expect(pa0[0]).toBe(10)
					expect(pa1[0]).toBe(-20)

					// Test mutation
					pa1[0] = -99
					expect(pa1[0]).toBe(-99)
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
					const payload = this.compile({ primitiveComponent: data })

					expect(payload.buffers.primitiveComponent.f64[0]).toBe(1.1)
					// f32 will have precision loss
					expect(Math.abs(payload.buffers.primitiveComponent.f32[0] - 2.2) < 1e-6).toBe(true)
					expect(payload.buffers.primitiveComponent.i32[0]).toBe(-3)
					expect(payload.buffers.primitiveComponent.u32[0]).toBe(4)
					expect(payload.buffers.primitiveComponent.i16[0]).toBe(-5)
					expect(payload.buffers.primitiveComponent.u16[0]).toBe(6)
					expect(payload.buffers.primitiveComponent.i8[0]).toBe(-7)
					expect(payload.buffers.primitiveComponent.u8[0]).toBe(8)
					expect(payload.buffers.primitiveComponent.boolean[0]).toBe(1)
				})

				it('should correctly compile a string component', () => {
					const payload = this.compile({ stringComponent: { value: 'test_string' } })
					const internedId = stringInterningTable.intern('test_string')
					expect(payload.buffers.stringComponent.value[0]).toBe(internedId)
				})

				it('should correctly compile an enum component', () => {
					// The interpreter no longer supports string-to-number conversion for enums.
					// Data must be provided in its raw, numeric form.
					const payload = this.compile({ enumComponent: { state: 2 } })
					expect(payload.buffers.enumComponent.state[0]).toBe(2)
				})

				it('should correctly compile a bitmask component', () => {
					// The interpreter no longer supports string-to-number conversion for bitmasks.
					// Data must be provided in its raw, numeric form (1 | 4 = 5).
					const payload = this.compile({ bitmaskComponent: { flags: 5 } })
					expect(payload.buffers.bitmaskComponent.flags[0]).toBe(5)
				})

				it('should correctly compile an entity reference component', () => {
					const entityId = 1234567890123456789n
					const payload = this.compile({ entityRefComponent: { target: entityId } })

					expect(payload.buffers.entityRefComponent.target).toBeInstanceOf(BigUint64Array)
					expect(payload.buffers.entityRefComponent.target[0]).toBe(entityId)
				})

				it('should correctly compile an RPN component', () => {
					const payload = this.compile({
						rpnComponent: { formulas: ['10 * BASE'] },
					})

					// RPN: 10, BASE, * -> PUSH_LITERAL, 10, PUSH_BASE, MULTIPLY
					// Opcodes: -1, 10, -2, -6
					const stream0 = payload.buffers.rpnComponent.formulas_rpnStream0
					const stream1 = payload.buffers.rpnComponent.formulas_rpnStream1
					const stream2 = payload.buffers.rpnComponent.formulas_rpnStream2
					const stream3 = payload.buffers.rpnComponent.formulas_rpnStream3
					const starts0 = payload.buffers.rpnComponent.formulas_formulaStarts0
					const lengths0 = payload.buffers.rpnComponent.formulas_formulaLengths0
					const streamCount = payload.buffers.rpnComponent.formulas_rpnStream_count

					expect(stream0).toBeInstanceOf(Float32Array)
					expect(starts0).toBeInstanceOf(Int16Array)
					expect(lengths0).toBeInstanceOf(Uint8Array)
					expect(streamCount).toBeInstanceOf(Uint8Array)

					expect(streamCount[0]).toBe(4) // 4 elements in the stream
					expect(starts0[0]).toBe(0) // starts at index 0
					expect(lengths0[0]).toBe(4) // length is 4

					// Check the stream content. The interpreter compiles it.
					expect(stream0[0]).toBe(-1) // PUSH_LITERAL
					expect(stream1[0]).toBe(10)
					expect(stream2[0]).toBe(-2) // PUSH_BASE
					expect(stream3[0]).toBe(-6) // MULTIPLY
				})

				it('should correctly compile a flat array of enums', () => {
					// The interpreter no longer supports string-to-number conversion for enums in arrays.
					// Data must be provided in its raw, numeric form.
					const payload = this.compile({ flatArrayComponent: { enumArray: [1, 0] } })

					const ea0 = payload.buffers.flatArrayComponent.enumArray0
					const eaCount = payload.buffers.flatArrayComponent.enumArray_count

					// Schema defines 'of: enum', which defaults to u8 storage
					expect(ea0).toBeInstanceOf(Uint8Array)
					expect(eaCount[0]).toBe(2)
					// VAL2 is 1, VAL1 is 0
					expect(ea0[0]).toBe(1)
				})

				it('should correctly compile a flat array of strings', () => {
					const payload = this.compile({ flatArrayComponent: { stringArray: ['a', 'b'] } })

					const sa0 = payload.buffers.flatArrayComponent.stringArray0
					const saCount = payload.buffers.flatArrayComponent.stringArray_count
					const internedA = stringInterningTable.intern('a')

					expect(sa0).toBeInstanceOf(Uint32Array)
					expect(saCount[0]).toBe(2)
					expect(sa0[0]).toBe(internedA)
				})
			})

			describe('compile(object | prefab) - Entity Payloads', () => {
				it('should apply defaults when a prefab uses a shorthand', () => {
					const payload = this.compile('ShorthandDefaultTest.prefab', {
						overrides: { testEntityTag: {} },
					})

					// Verify buffers
					expect(payload.buffers.shorthandDefaultComponent).toBeDefined()
					// Check the shorthand value
					expect(payload.buffers.shorthandDefaultComponent.value[0]).toBe(123)

					// Check the default value
					const internedDefaultText = stringInterningTable.intern('default_text')
					expect(payload.buffers.shorthandDefaultComponent.text[0]).toBe(internedDefaultText)

					// Verify by creating an entity
					// Use the system's deferred command.
					this.instantiate(payload, 1)
					ecs.executeCommandBuffer()

					// Use a query to find the real entity ID.
					const query = this.getQuery({ with: [shorthandDefaultComponent, testEntityTag] })
					const realEntityId = query.getSingleEntity()
					expect(realEntityId).toBeDefined()

					const compData = ecs.getComponent(realEntityId, 'ShorthandDefaultComponent')

					expect(compData).toBeDefined()
					expect(compData.value).toBe(123)
					expect(compData.text).toBe('default_text')

					ecs.destroyEntity(realEntityId)
				})

				it('should apply defaults when an object uses a shorthand', () => {
					const payload = this.compile({
						shorthandDefaultComponent: 456,
						testEntityTag: {},
					})

					// Verify buffers
					expect(payload.buffers.shorthandDefaultComponent).toBeDefined()

					// Check the shorthand value
					expect(payload.buffers.shorthandDefaultComponent.value[0]).toBe(456)

					// Check the default value
					const internedDefaultText = stringInterningTable.intern('default_text')
					expect(payload.buffers.shorthandDefaultComponent.text[0]).toBe(internedDefaultText)

					// Verify by creating an entity
					this.instantiate(payload, 1)
					ecs.executeCommandBuffer()

					const query = this.getQuery({ with: [shorthandDefaultComponent, testEntityTag] })
					const realEntityId = query.getSingleEntity()
					expect(realEntityId).toBeDefined()

					const compData = ecs.getComponent(realEntityId, 'ShorthandDefaultComponent')

					expect(compData).toBeDefined()
					expect(compData.value).toBe(456)
					expect(compData.text).toBe('default_text')

					ecs.destroyEntity(realEntityId)
				})

				it('should compile an entity from a component object', () => {
					const source = {
						position: { x: 10, y: 20 },
						velocity: { x: 1, y: 2 },
						testEntityTag: {}, // Add tag for isolation
					}
					const payload = this.compile(source)

					// Verify payload structure
					expect(payload).toBeDefined()
					const expectedArchetype = entityManager.getArchetype([position, velocity, testEntityTag])
					expect(payload.archetypeId).toBe(expectedArchetype)
					expect(payload.capacity).toBe(1)

					// Verify buffers
					// Tag components have no properties, so they should not have a buffer.
					expect(payload.buffers.testEntityTag).toBeUndefined()

					expect(payload.buffers).toBeDefined()
					expect(payload.buffers.position.x[0]).toBe(10)
					expect(payload.buffers.position.y[0]).toBe(20)
					expect(payload.buffers.velocity.x[0]).toBe(1)
					expect(payload.buffers.velocity.y[0]).toBe(2)

					// Test mutation
					payload.buffers.position.x[0] = -5
					expect(payload.buffers.position.x[0]).toBe(-5)

					// Verify by creating an entity
					this.instantiate(payload, 1)
					ecs.executeCommandBuffer()

					const query = this.getQuery({ with: [position, velocity, testEntityTag] }) 
					const realEntityId = query.getSingleEntity()
					expect(realEntityId).toBeDefined()

					const pos = ecs.getComponent(realEntityId, 'Position')
					const vel = ecs.getComponent(realEntityId, 'Velocity')

					expect(pos).toEqual({ x: -5, y: 20 })
					expect(vel).toEqual({ x: 1, y: 2 })

					ecs.destroyEntity(realEntityId)
				})

				it('should compile an entity from a prefab name', () => {
					const payload = this.compile('test_prefab')

					// 1. Verify Archetype (test_prefab includes position, velocity, testEntityTag)
					const expectedArchetype = entityManager.getArchetype([position, velocity, testEntityTag])
					expect(payload.archetypeId).toBe(expectedArchetype)

					// 2. Verify Data Buffers
					// Prefab has Position: {x:0, y:0}, Velocity: {x:0, y:0}, TestEntityTag: {}
					expect(payload.buffers.position.x[0]).toBe(0)
					expect(payload.buffers.position.y[0]).toBe(0)
					expect(payload.buffers.velocity.x[0]).toBe(0)
					expect(payload.buffers.velocity.y[0]).toBe(0)
					// 3. Verify Tag Component (no buffer)
					expect(payload.buffers.testEntityTag).toBeUndefined()

					// Verify by creating an entity
					this.instantiate(payload, 1)
					ecs.executeCommandBuffer()

					const query = this.getQuery({ with: [position, velocity, testEntityTag] }) 
					const realEntityId = query.getSingleEntity()
					expect(realEntityId).toBeDefined()

					const pos = ecs.getComponent(realEntityId, 'Position')
					const vel = ecs.getComponent(realEntityId, 'Velocity')
					const hasTag = ecs.hasComponent(realEntityId, 'TestEntityTag')

					expect(pos).toEqual({ x: 0, y: 0 })
					expect(vel).toEqual({ x: 0, y: 0 })
					expect(hasTag).toBe(true)

					ecs.destroyEntity(realEntityId)
				})

				it('should compile an entity from a prefab with object overrides', () => {
					const overrides = {
						position: { y: 99 },
						velocity: { x: -10 },
					}
					const payload = this.compile('test_prefab', { overrides })

					// Prefab has Position: {x:0, y:0}, Velocity: {x:0, y:0}
					// Overrides change y to 99 and x to -10
					expect(payload.buffers.position.x[0]).toBe(0) // from prefab
					expect(payload.buffers.position.y[0]).toBe(99) // from override
					expect(payload.buffers.velocity.x[0]).toBe(-10) // from override
					expect(payload.buffers.velocity.y[0]).toBe(0) // from prefab

					// Verify by creating an entity
					this.instantiate(payload, 1)
					ecs.executeCommandBuffer()

					const query = this.getQuery({ with: [position, velocity, testEntityTag] }) 
					const realEntityId = query.getSingleEntity()
					expect(realEntityId).toBeDefined()

					const pos = ecs.getComponent(realEntityId, 'Position')
					const vel = ecs.getComponent(realEntityId, 'Velocity')

					expect(pos).toEqual({ x: 0, y: 99 })
					expect(vel).toEqual({ x: -10, y: 0 })

					ecs.destroyEntity(realEntityId)
				})
				it('should correctly apply a shorthand override on a prefab', () => {
					const payload = this.compile('ShorthandDefaultTest.prefab', {
						overrides: {
							shorthandDefaultComponent: 999,
							testEntityTag: {}, // Add tag for isolation
						},
					})

					// Check the shorthand value from the override
					expect(payload.buffers.shorthandDefaultComponent.value[0]).toBe(999)

					// Check the default value (which should still be applied)
					const internedDefaultText = stringInterningTable.intern('default_text')
					expect(payload.buffers.shorthandDefaultComponent.text[0]).toBe(internedDefaultText)

					this.instantiate(payload, 1)
					ecs.executeCommandBuffer()

					const query = this.getQuery({ with: [shorthandDefaultComponent, testEntityTag] })
					const realEntityId = query.getSingleEntity()
					expect(realEntityId).toBeDefined()

					const compData = ecs.getComponent(realEntityId, 'ShorthandDefaultComponent')
					expect(compData).toEqual({ value: 999, text: 'default_text' })
					ecs.destroyEntity(realEntityId)
				})
			})

			describe('Integration with ECS.instantiate()', () => {
				it('should correctly apply a shorthand override during immediate-mode instantiation', () => {
					const entityId = ecs.instantiate('ShorthandDefaultTest.prefab', {
						shorthandDefaultComponent: 999,
					})

					expect(entityId).toBeDefined()
					const compData = ecs.getComponent(entityId, 'ShorthandDefaultComponent')
					expect(compData).toEqual({ value: 999, text: 'default_text' })

					// Cleanup
					ecs.destroyEntity(entityId)
				})

				it('should correctly apply a partial object override during immediate-mode instantiation', () => {
					const entityId = ecs.instantiate('ShorthandDefaultTest.prefab', {
						shorthandDefaultComponent: { text: 'overridden text' },
					})

					expect(entityId).toBeDefined()
					const compData = ecs.getComponent(entityId, 'ShorthandDefaultComponent')
					expect(compData).toEqual({ value: 123, text: 'overridden text' })

					// Cleanup
					ecs.destroyEntity(entityId)
				})
			})

			describe('compile() - Overrides and Excludes', () => {
				it('should compile from a prefab, applying overrides and excludes', () => {
					// The 'test_prefab' has Position {x:0, y:0}, Velocity {x:0, y:0}, TestEntityTag
					// The schema for Health has a default of { current: 100, max: 100 }
					const payload = this.compile('test_prefab', {
						overrides: {
							// Override the default for position
							position: { x: 50, y: 50 },
						},
						excludes: [
							// Exclude the Velocity component by its ID
							velocity,
						],
					})

					// 1. Verify Archetype & Size
					// The resulting payload should contain Position and TestEntityTag.
					const expectedArchetype = entityManager.getArchetype([position, testEntityTag])
					expect(payload.archetypeId).toBe(expectedArchetype)
					expect(payload.capacity).toBe(1)

					// 2. Verify Buffers and Values
					expect(payload.buffers.position).toBeDefined()
					expect(payload.buffers.velocity).toBeUndefined()
					expect(payload.buffers.testEntityTag).toBeUndefined()

					const mutators = payload.buffers // Alias for readability in the rest of the test
 
					// Check the overridden value
					expect(mutators.position.x[0]).toBe(50)
					expect(mutators.position.y[0]).toBe(50)

					// 3. Verify on a real entity (via command buffer)
					const creationPayload = this.compile({
						position: { x: 999, y: 999 },
						velocity: { x: 1, y: 1 },
						testEntityTag: {},
					})
					this.instantiate(creationPayload, 1)
					this.flush()

					const query = this.getQuery({ with: [position, velocity, testEntityTag] })
					const realEntityId = query.getSingleEntity()
					expect(realEntityId).toBeDefined()
					
					this.setComponents(realEntityId, payload)
					this.flush()

					const pos = ecs.getComponent(realEntityId, 'position')
					const vel = ecs.getComponent(realEntityId, 'velocity')

					// Position should be reset to the overridden default
					expect(pos).toEqual({ x: 50, y: 50 })
					// Velocity should be untouched because it was excluded from the payload
					expect(vel).toEqual({ x: 1, y: 1 })

					ecs.destroyEntity(realEntityId)
				})

				it('should use schema defaults when an empty object override is provided for a prefab', () => {
					// The 'ShorthandDefaultTest.prefab' has { value: 123 } and a default text from schema.
					// We override with an empty object to force a full reset to schema defaults.
					const payload = this.compile('ShorthandDefaultTest.prefab', {
						overrides: {
							shorthandDefaultComponent: {}, // This signals "use schema defaults"
						},
					})

					// The component should be compiled with its schema defaults, not the prefab's value.
					expect(payload.buffers.shorthandDefaultComponent.value[0]).toBe(-1) // Default from schema
					const internedDefaultText = stringInterningTable.intern('default_text')
					expect(payload.buffers.shorthandDefaultComponent.text[0]).toBe(internedDefaultText) // Default from schema
				})

				it('should compile from a component object, applying excludes', () => {
					// Schemas: Position defaults to {x:0, y:0}, Health to {current:100, max:100}
					const sourceObject = {
						position: {},
						health: {},
					}
					const payload = this.compile(sourceObject, { excludes: [health] }) // Exclude health

					// Verify Archetype & Size
					const expectedArchetype = entityManager.getArchetype([position])
					expect(payload.archetypeId).toBe(expectedArchetype)
					expect(payload.buffers.health).toBeUndefined()
				})
			})
		})

		await testManager.runAllTests()
	}

	destroy() {
		testManager.clear()
	}
}
