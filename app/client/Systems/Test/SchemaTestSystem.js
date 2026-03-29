const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const { componentManager } = ecs
const { testManager } = await import(`@client/Managers/TestManager/TestManager.js`)
const { describe, it, expect } = await import(`@client/Managers/TestManager/TestAPI.js`)

// Imports needed for the new test
const { ChunkView } = await import('@managers/QueryManager/ChunkView.js')
import { DIRTY_HISTORY_LENGTH } from '@managers/ComponentManager/ComponentSchema.js'
const { entityStore } = await import('@managers/EntityManager/EntityManager.js')

const { enableableTestComponent, trackedTestComponent } = ecs.getTypeIDs()

/**
 * A system dedicated to testing the functionality of the SchemaParser and data layer.
 * It runs a suite of self-contained tests for each schema type during its `init` phase.
 */
export class SchemaTestSystem {
	constructor() {
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
			enableable: true,
			tracked: true,
		}
	}

	async init() {
		// Get component IDs after they have been registered.

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
					const stateConstants = ecs.getConstantsForProperty('EnumComponent', 'state')
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
					const stateConstants = ecs.getConstantsForProperty('EnumComponent', 'state')
					expect(stateConstants).toBeDefined()
					expect(stateConstants).toEqual({ IDLE: 0, RUNNING: 1, JUMPING: 2 })
				})
			}

			if (this.testConfig.bitmasks) {
				it('should correctly store and retrieve bitmask values', () => {
					const flagConstants = ecs.getConstantsForProperty('BitmaskComponent', 'flags')
					const initialData = { flags: flagConstants.FLAG_A | flagConstants.FLAG_C } // Use numeric value
					const entityId = ecs.createEntity({ BitmaskComponent: initialData })

					const retrievedData = ecs.getComponent(entityId, 'BitmaskComponent')

					// The component now returns the raw numeric bitmask.
					const expectedFlags = flagConstants.FLAG_A | flagConstants.FLAG_C
					expect(retrievedData.flags).toBe(expectedFlags)

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.bitmaskConstants) {
				it('should correctly retrieve bitmask constants via the ComponentManager', () => {
					const flagConstants = ecs.getConstantsForProperty('BitmaskComponent', 'flags')
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
					const enumArrayConstants = ecs.getConstantsForProperty('FlatArrayComponent', 'enumArray')
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

			if (this.testConfig.enableable) {
				it('should correctly toggle and query enableable components', async () => {
					const entityId = ECS.createEntity({ enableableTestComponent: { value: 1.0 } })
					// We need to flush to ensure the entity is created and located.
					this.flush()

					const location = ecs.entityManager.getEntityLocation(entityId)
					expect(location).toBeDefined()

					const chunkView = new ChunkView(entityStore)
					chunkView.setChunk(location.chunkId)
					const scratchBuffer = new Uint32Array(chunkView.size)

					// 1. Check initial state (should be enabled by default thanks to our fix)
					let enabledCount = chunkView.getEnabledIndices(enableableTestComponent, scratchBuffer)
					expect(enabledCount).toBe(1)
					expect(scratchBuffer[0]).toBe(location.indexInChunk)

					// 2. Disable the component using a deferred command
					this.disableComponent(entityId, enableableTestComponent)
					this.flush() // Execute the command

					// 3. Check disabled state
					// The chunk view is still valid as the entity has not moved.
					enabledCount = chunkView.getEnabledIndices(enableableTestComponent, scratchBuffer)
					expect(enabledCount).toBe(0)

					// 4. Re-enable the component using a deferred command
					this.enableComponent(entityId, enableableTestComponent)
					this.flush()

					// 5. Check enabled state again
					enabledCount = chunkView.getEnabledIndices(enableableTestComponent, scratchBuffer)
					expect(enabledCount).toBe(1)
					expect(scratchBuffer[0]).toBe(location.indexInChunk)

					ECS.destroyEntity(entityId)
				})
			}

			if (this.testConfig.tracked) {
				describe('Tracked Components', () => {
					it('should correctly track and query dirty components', async () => {
						const entityId = ECS.createEntity({ trackedTestComponent: { value: 1.0 } })
						this.flush() // Ensure entity is created

						const location = ecs.entityManager.getEntityLocation(entityId)
						expect(location).toBeDefined()

						const chunkView = new ChunkView(entityStore)
						chunkView.setChunk(location.chunkId)
						const scratchBuffer = new Uint32Array(chunkView.size)

						// --- Test 1: Immediate-mode marking ---
						chunkView.markEntityDirty(location.indexInChunk, trackedTestComponent, 1)
						chunkView._setLastTick(1) // Simulate current tick for getChangedIndices
						let changedCount = chunkView.getChangedIndices(trackedTestComponent, 0, scratchBuffer)
						expect(changedCount).toBe(1, 'Immediate mark at tick 1 should be detected when querying (0, 1]')
						expect(scratchBuffer[0]).toBe(location.indexInChunk)

						// --- Test 2: No changes since last tick ---
						chunkView._setLastTick(1) // current tick is 1
						changedCount = chunkView.getChangedIndices(trackedTestComponent, 1, scratchBuffer)
						expect(changedCount).toBe(0, 'Should not detect changes from the same tick')

						// --- Test 3: Deferred-mode marking ---
						this.markDirty(entityId, trackedTestComponent, 3) // Mark for a future tick
						this.flush() // Execute the command
						chunkView._setLastTick(3)
						changedCount = chunkView.getChangedIndices(trackedTestComponent, 2, scratchBuffer)
						expect(changedCount).toBe(1, 'Deferred mark at tick 3 should be detected when querying (2, 3]')
						expect(scratchBuffer[0]).toBe(location.indexInChunk)

						// --- Test 4: Querying over a window of time ---
						chunkView.markEntityDirty(location.indexInChunk, trackedTestComponent, 5)
						chunkView._setLastTick(10) // Simulate time has passed to tick 10
						changedCount = chunkView.getChangedIndices(trackedTestComponent, 4, scratchBuffer)
						expect(changedCount).toBe(1, 'Should detect change at tick 5 within a window of (4, 10]')
						expect(scratchBuffer[0]).toBe(location.indexInChunk)

						// --- Test 5: History Overflow Read Logic (Hit Case) ---
						// This test verifies that the read logic correctly calculates the start
						// of the historical window when an overflow occurs.
						chunkView._setLastTick(4 + DIRTY_HISTORY_LENGTH) // currentTick = 68. lastTick = 4. tickDelta = 64.
						// This triggers the overflow condition. The history window to check should become [5, 68].
						// Our change at tick 5 should be the very first thing it finds.
						changedCount = chunkView.getChangedIndices(trackedTestComponent, 4, scratchBuffer)
						expect(changedCount).toBe(1, 'Should detect change at the start of an overflowed history window')
						expect(scratchBuffer[0]).toBe(location.indexInChunk)

						ECS.destroyEntity(entityId)
					})

					it('should preserve changes on overflow via Saturated History', async () => {
						const entityId = ECS.createEntity({ trackedTestComponent: { value: 1.0 } })
						this.flush()

						const location = ecs.entityManager.getEntityLocation(entityId)
						const chunkView = new ChunkView(entityStore)
						chunkView.setChunk(location.chunkId)
						const scratchBuffer = new Uint32Array(chunkView.size)
						const wordsPerFrame = Math.ceil(chunkView.capacity / 32)
						const dirtyMasks = entityStore.chunkMetadata[location.chunkId][trackedTestComponent].dirtyMasks

						/**
						 * This is a helper function that simulates the core logic of the end-of-frame maintenance job.
						 * It's included here to test the "Saturated History" feature without needing to run the full scheduler.
						 * It performs two actions:
						 * 1. Saturate: It copies the bitmask from the oldest frame into the next-oldest frame.
						 * 2. Clear: It clears the bitmask for the frame that is about to be used.
						 */
						const simulateMaintenanceJobForTick = currentTick => {
							const oldestTickToOverwrite = currentTick + 1 - DIRTY_HISTORY_LENGTH
							const saturatingTick = oldestTickToOverwrite + 1
							const tickToClear = currentTick + 1

							const oldestFrameIndex = oldestTickToOverwrite % DIRTY_HISTORY_LENGTH
							const saturatingFrameIndex = saturatingTick % DIRTY_HISTORY_LENGTH
							const clearFrameIndex = tickToClear % DIRTY_HISTORY_LENGTH

							const oldestSliceStart = oldestFrameIndex * wordsPerFrame
							const saturatingSliceStart = saturatingFrameIndex * wordsPerFrame
							const clearSliceStart = clearFrameIndex * wordsPerFrame

							// Saturate: OR the oldest data into the next-oldest slot
							for (let i = 0; i < wordsPerFrame; i++) {
								const oldValue = Atomics.load(dirtyMasks, oldestSliceStart + i)
								if (oldValue !== 0) {
									Atomics.or(dirtyMasks, saturatingSliceStart + i, oldValue)
								}
							}

							// Clear: Zero out the slot for the upcoming frame
							dirtyMasks.fill(0, clearSliceStart, clearSliceStart + wordsPerFrame)
						}

						// 1. Mark a change at an early tick.
						const changeTick = 5
						chunkView.markEntityDirty(location.indexInChunk, trackedTestComponent, changeTick)

						// 2. Simulate the passage of time by running the maintenance job repeatedly.
						// We run it up to the point where the data from tick 5 would have been saturated
						// all the way into the slot for tick 37.
						// The job at tick (5 + 63) = 68 saturates 5->6.
						// The job at tick (6 + 63) = 69 saturates 6->7.
						// ...
						// The job at tick (36 + 63) = 99 saturates 36->37. 
						for (let tick = changeTick + DIRTY_HISTORY_LENGTH - 1; tick <= 36 + DIRTY_HISTORY_LENGTH - 1; tick++) {
							simulateMaintenanceJobForTick(tick)
						}

						// 3. Now, query from a time far in the future, where the original change at tick 5
						// is long outside the history window.
						const queryTick = 100
						chunkView._setLastTick(queryTick)

						// Query for changes since tick 4. This will trigger an overflow read.
						// The query's effective start tick will be (100 - 64 + 1) = 37.
						// Because we simulated the maintenance job, the change from tick 5 should now
						// be present in the bitmask for tick 37.
						const changedCount = chunkView.getChangedIndices(trackedTestComponent, 4, scratchBuffer)

						// This is the key assertion. The change from tick 5 should have been preserved.
						expect(changedCount).toBe(1, 'Saturated change should be detected on history overflow')
						expect(scratchBuffer[0]).toBe(location.indexInChunk)

						ECS.destroyEntity(entityId)
					})

					it('should NOT mark component as dirty when using setComponentDataSilent', () => {
						const { payload } = this.compile(trackedTestComponent, { value: 999 })

						// 1. Create the entity. This is immediate and marks the component dirty for the current tick.
						const entityId = ECS.createEntity({ trackedTestComponent: { value: 1.0 } })
						const creationTick = ecs.systemManager.currentTick

						// 2. Queue the silent set command.
						this.setComponentDataSilent(entityId, payload)

						// 3. Flush the command buffer. This executes the silent set.
						this.flush()

						// 4. Setup the chunk view for verification.
						const location = ecs.entityManager.getEntityLocation(entityId)
						const chunkView = new ChunkView(entityStore)
						chunkView.setChunk(location.chunkId)
						const scratchBuffer = new Uint32Array(chunkView.size)

						// 5. VERIFICATION: Check for changes in a window that *excludes* the creation tick.
						const nextTick = creationTick + 1
						chunkView._setLastTick(nextTick) // Simulate time is now tick 2
						const changedCount = chunkView.getChangedIndices(trackedTestComponent, creationTick, scratchBuffer)
						expect(changedCount).toBe(0, 'setComponentDataSilent should not trigger change detection in a subsequent tick window')

						// Verify that the data was, in fact, updated
						const componentData = ECS.getComponent(entityId, 'trackedTestComponent')
						expect(componentData.value).toBe(999)
					})
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
