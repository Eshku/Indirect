const { engine } = await import(`@client/Engine.js`)
const { ecs, testManager } = engine.getManagers()
const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`)
 
const { entityMaskManager } = engine.getManagers() 

// Use existing components for testing to avoid schema changes.
const { componentA, componentB } = ecs.getComponentIDs()

/**
 * A system dedicated to testing the new GeneralizedBitmaskFilters functionality.
 * It verifies the creation, writing, and querying of both State and Event masks.
 */
export class EntityMaskManagerTestSystem {
	init() {
		// State for the ring buffer overflow test
		this.ringBufferTestPhase = 'INIT'
		this.ringBufferTestResolve = null
		this.ringBufferTestDamagedMaskId = null
		this.ringBufferTestChunkId = null
		
		this.entityMaskManager = entityMaskManager 

		// Helpers to make tests cleaner
		const flush = () => this.flush()
		const cleanup = () => {
			const query = this.getQuery({ with: [componentA] })
			const chunkIds = query.getChunks()
			for (let i = 0; i < chunkIds.length; i++) {
				this.destroyEntitiesInChunk(chunkIds[i])
			}
			flush() 
			this.entityMaskManager.clear() // Clear all registered mask sets for test isolation
		}

		describe('EntityMaskManager', () => { 
			// --- STATE MASK TESTS ---
			describe('State Masks', () => {
				it('should set, clear, and query bits for a state mask', () => { 
					cleanup()

					// 1. Setup: Register a state mask that allocates for archetypes with componentA
					const allocationRule = { with: [componentA] }
					const selectedMaskId = this.entityMaskManager.createStateMask('bitmask_test:selected', allocationRule)

					// 2. Create entities that will match the allocation query
					const { payload } = this.compile({ componentA: {} })
					const entities = [this.createEntity(payload), this.createEntity(payload), this.createEntity(payload)]
					flush()

					// 3. Get real entity IDs and chunk info
					const query = this.getQuery({ with: [componentA] })
					const chunkIds = query.getChunks()
					expect(chunkIds.length).toBe(1)
					const chunkId = chunkIds[0]
					const realEntities = this.getEntities(chunkId).slice(0, this.getChunkSize(chunkId))
					expect(realEntities.length).toBe(3)
					const scratchBuffer = this.createScratchBuffer()

					// 4. Action: Set bits for specific entities
					this.entityMaskManager.setBitById(selectedMaskId, realEntities[0]) 
					this.entityMaskManager.setBitById(selectedMaskId, realEntities[2]) 

					// 5. Verification: Check which entities are selected
					let selectedCount = this.entityMaskManager.getStateIndices(selectedMaskId, chunkId, scratchBuffer) 
					expect(selectedCount).toBe(2)
					const selectedIndices = Array.from(scratchBuffer.slice(0, selectedCount))
					// The indices in the chunk should be 0 and 2
					expect(selectedIndices.includes(0)).toBe(true)
					expect(selectedIndices.includes(1)).toBe(false)
					expect(selectedIndices.includes(2)).toBe(true)
					
					// 6. Action: Clear a bit
					this.entityMaskManager.clearBitById(selectedMaskId, realEntities[0]) 

					// 7. Verification: Check again
					selectedCount = this.entityMaskManager.getStateIndices(selectedMaskId, chunkId, scratchBuffer) 
					expect(selectedCount).toBe(1)
					expect(scratchBuffer[0]).toBe(2) // Only entity at index 2 should be left
				})

				it('should correctly handle swap-and-pop during entity moves', () => {
					cleanup()

					// 1. Setup
					const allocationRule = { with: [componentA] }
					const selectedMaskId = this.entityMaskManager.createStateMask('bitmask_test:swap_pop', allocationRule)
					const { payload: creationPayload } = this.compile({ componentA: {} })

					// Create two entities in the same chunk
					this.createEntity(creationPayload)
					this.createEntity(creationPayload)
					flush()

					const query = this.getQuery({ with: [componentA] })
					const chunkId = query.getChunks()[0]
					const entities = this.getEntities(chunkId).slice(0, 2)
					const entityToMove = entities[0] // at index 0
					const entityToSwap = entities[1] // at index 1

					// 2. Set state: select the entity to move, but not the one to be swapped.
					this.entityMaskManager.setBitById(selectedMaskId, entityToMove) 

					// Verify initial state
					const scratchBuffer = this.createScratchBuffer()
					let selectedCount = this.entityMaskManager.getStateIndices(selectedMaskId, chunkId, scratchBuffer) 
					expect(selectedCount).toBe(1) 
					expect(scratchBuffer[0]).toBe(0) // Index of entityToMove

					// 3. Force an archetype move on the first entity
					const { payload: addPayload } = this.compile(componentB, {})
					this.addComponent(entityToMove, addPayload)
					flush()

					// 4. Verification
					// The old chunk now contains only the swapped entity, which has been moved to index 0.
					// Its bit should be CLEAR, as it was never set. The bug would cause it to inherit
					// the SET bit from the moved entity's old slot.
					selectedCount = this.entityMaskManager.getStateIndices(selectedMaskId, chunkId, scratchBuffer) 
					expect(selectedCount).toBe(0, 'State bit for swapped entity should be clear')
				})

				it('should preserve state for a swapped entity and clear the old slot', () => {
					cleanup()

					// 1. Setup
					const allocationRule = { with: [componentA] }
					const selectedMaskId = this.entityMaskManager.createStateMask('bitmask_test:swap_preserve', allocationRule)
					const { payload: creationPayload } = this.compile({ componentA: {} })

					// Create two entities in the same chunk
					this.createEntity(creationPayload)
					this.createEntity(creationPayload)
					flush()

					const query = this.getQuery({ with: [componentA] })
					const chunkId = query.getChunks()[0]
					const entities = this.getEntities(chunkId).slice(0, 2)
					const entityToDestroy = entities[0] // at index 0
					const entityToSwap = entities[1]    // at index 1

					// 2. Set state: select the entity that will be swapped.
					this.entityMaskManager.setBitById(selectedMaskId, entityToSwap)

					// Verify initial state
					const scratchBuffer = this.createScratchBuffer()
					let selectedCount = this.entityMaskManager.getStateIndices(selectedMaskId, chunkId, scratchBuffer)

					expect(selectedCount).toBe(1, 'Initial state should have one selected entity')
					expect(scratchBuffer[0]).toBe(1, 'Initially selected entity should be at index 1')

					// 3. Destroy the first entity, causing the second to be swapped into its place.
					this.destroyEntity(entityToDestroy)
					flush()

					// 4. Verification after swap
					// The swapped entity is now at index 0. Its bit should be set.
					selectedCount = this.entityMaskManager.getStateIndices(selectedMaskId, chunkId, scratchBuffer)
					expect(selectedCount).toBe(1, 'State bit for swapped entity should be preserved at new index')
					expect(scratchBuffer[0]).toBe(0, 'Swapped entity should now be at index 0')

					// 5. Create a new entity. It will occupy the old slot of the swapped entity (index 1).
					this.createEntity(creationPayload)
					flush()

					// 6. Verification after new entity creation
					// The new entity should NOT have the bit set. The bug would cause it to inherit the stale bit.
					selectedCount = this.entityMaskManager.getStateIndices(selectedMaskId, chunkId, scratchBuffer)

					expect(selectedCount).toBe(1, 'New entity should not inherit stale state bit from old slot')
					expect(this.getChunkSize(chunkId)).toBe(2)
				})

				it('should preserve state when an entity moves to a new chunk', () => {
					cleanup()

					// 1. Setup
					const allocationRule = { with: [componentA] }
					const selectedMaskId = this.entityMaskManager.createStateMask('bitmask_test:move_selected', allocationRule)
					const { payload: creationPayload } = this.compile({ componentA: {} })
					const entityPlaceholder = this.createEntity(creationPayload)
					flush()

					const query = this.getQuery({ with: [componentA] })
					const entityId = query.getSingleEntity()
					const oldLocation = this.getEntityLocation(entityId)
					expect(oldLocation).toBeDefined()

					// 2. Set state on the entity in its original chunk
					this.entityMaskManager.setBitById(selectedMaskId, entityId) 
					const scratchBuffer = this.createScratchBuffer() 
					const initialCount = this.entityMaskManager.getStateIndices(selectedMaskId, oldLocation.chunkId, scratchBuffer)
					expect(initialCount).toBe(1)

					// 3. Force an archetype move by adding a component
					const { payload: addPayload } = this.compile(componentB, {})
					this.addComponent(entityId, addPayload)
					flush()

					// 4. Verification
					const newLocation = this.getEntityLocation(entityId)
					expect(newLocation).toBeDefined()
					expect(newLocation.chunkId).not.toBe(oldLocation.chunkId, 'Entity should have moved to a new chunk')

					// The bit should have been copied to the new chunk's mask 
					const newCount = this.entityMaskManager.getStateIndices(selectedMaskId, newLocation.chunkId, scratchBuffer) 
					expect(newCount).toBe(1, 'State bit should be preserved after moving chunks')
					expect(scratchBuffer[0]).toBe(newLocation.indexInChunk)
					
					// The old chunk's mask should now be empty
					const oldCount = this.entityMaskManager.getStateIndices(selectedMaskId, oldLocation.chunkId, scratchBuffer)
					expect(oldCount).toBe(0, 'State bit should be cleared from the old chunk after a move')
				})
			})

			// --- COMMON PATTERN TESTS ---
			describe('Common Patterns', () => {
				it('should handle enable/disable state for a component', () => {
					cleanup()
					// After cleanup(), we must re-register any masks needed for the test,
					// as `clear()` wipes the manager's state.
					this.entityMaskManager.registerEnableableMask(componentA)

					// 2. Create an entity. By default, its bit is not set, so it's "disabled".
					const { payload } = this.compile({ componentA: {} })
					this.createEntity(payload) // This returns a placeholder, don't store it.
					this.flush()

					const query = this.getQuery({ with: [componentA] })
					const entityId = query.getSingleEntity() // Get the REAL entity ID after the flush.
					expect(entityId).toBeDefined('Test entity should be found after creation.')

					const chunkId = query.getChunks()[0]
					const location = this.getEntityLocation(entityId)
					const scratchBuffer = this.createScratchBuffer()

					// 3. Verification: Initially disabled.
					let enabledCount = this.getEnabled(chunkId, componentA, scratchBuffer)
					expect(enabledCount).toBe(0, 'Entity should be disabled by default')

					// 4. Action: Enable the component on the entity.
					this.enableComponentById(entityId, componentA)

					// 5. Verification: Now enabled.
					enabledCount = this.getEnabled(chunkId, componentA, scratchBuffer)
					expect(enabledCount).toBe(1, 'Entity should be enabled after calling enable()')
					expect(scratchBuffer[0]).toBe(location.indexInChunk)

					// 6. Action: Disable the component on the entity.
					this.disableComponentById(entityId, componentA)

					// 7. Verification: Disabled again.
					enabledCount = this.getEnabled(chunkId, componentA, scratchBuffer)
					expect(enabledCount).toBe(0, 'Entity should be disabled after calling disable()')
				})
			})

			// --- ERROR HANDLING TESTS ---
			describe('Error Handling', () => {
				it('should throw a TypeError when enabling a non-enableable component', () => {
					cleanup()
					// componentB is not 'isEnableable'
					const { payload } = this.compile({ componentB: {} })
					const entityId = this.createEntity(payload)
					flush()

					// Test ById API
					expect(() => {
						this.enableComponentById(entityId, componentB)
					}).toThrow(TypeError)

					// Test non-ID API
					const location = this.getEntityLocation(entityId)
					expect(() => {
						this.enableComponent(location.chunkId, location.indexInChunk, componentB)
					}).toThrow(TypeError)
				})

				it('should throw a TypeError when disabling a non-enableable component', () => {
					cleanup()
					const { payload } = this.compile({ componentB: {} })
					const entityId = this.createEntity(payload)
					flush()

					// Test ById API
					expect(() => {
						this.disableComponentById(entityId, componentB)
					}).toThrow(TypeError)

					// Test non-ID API
					const location = this.getEntityLocation(entityId)
					expect(() => {
						this.disableComponent(location.chunkId, location.indexInChunk, componentB)
					}).toThrow(TypeError)
				})

				it('should throw a TypeError when getting enabled indices for a non-enableable component', () => {
					cleanup()
					// componentB is not 'isEnableable'
					const { payload } = this.compile({ componentB: {} })
					this.createEntity(payload)
					flush()

					const chunkId = this.getQuery({ with: [componentB] }).getChunks()[0]
					const scratchBuffer = this.createScratchBuffer()

					expect(() => {
						this.getEnabled(chunkId, componentB, scratchBuffer)
					}).toThrow(TypeError)
				})

				it('should throw a TypeError when checking if a non-enableable component is enabled', () => {
					cleanup()
					// componentB is not 'isEnableable'
					const { payload } = this.compile({ componentB: {} })
					const entityId = this.createEntity(payload)
					flush()

					const location = this.getEntityLocation(entityId)

					expect(() => {
						this.isComponentEnabled(location.chunkId, location.indexInChunk, componentB)
					}).toThrow(TypeError)
				})

				it('should throw a TypeError when masking a non-trackable component as dirty', () => {
					cleanup()
					// componentA is not 'isTrackable'
					const { payload } = this.compile({ componentA: {} })
					const entityId = this.createEntity(payload)
					flush()

					// Test ById API
					expect(() => {
						this.markEntityDirtyById(entityId, componentA, 1)
					}).toThrow(TypeError)

					// Test non-ID API
					const location = this.getEntityLocation(entityId)
					expect(() => {
						this.markEntityDirty(location.chunkId, location.indexInChunk, componentA, 1)
					}).toThrow(TypeError)
				})

				it('should throw a TypeError when getting dirty indices for a non-trackable component', () => {
					cleanup()
					const { payload } = this.compile({ componentA: {} })
					this.createEntity(payload)
					flush()

					const chunkId = this.getQuery({ with: [componentA] }).getChunks()[0]
					const scratchBuffer = this.createScratchBuffer()

					expect(() => {
						this.getDirty(chunkId, componentA, 0, 1, scratchBuffer)
					}).toThrow(TypeError)
				})
			})

			// --- EVENT MASK TESTS ---
			describe('Event Masks', () => {
				it('should fire and detect events in a single tick window', () => {
					cleanup()

					// 1. Setup 
					const allocationRule = { with: [componentA] }
					const damagedMaskId = this.entityMaskManager.createEventMask('bitmask_test:damaged', allocationRule)
					const { payload } = this.compile({ componentA: {} })
					const entities = [this.createEntity(payload), this.createEntity(payload), this.createEntity(payload)]
					flush()

					const query = this.getQuery({ with: [componentA] })
					const chunkIds = query.getChunks()
					expect(chunkIds.length).toBe(1)
					const chunkId = chunkIds[0]
					const realEntities = this.getEntities(chunkId).slice(0, this.getChunkSize(chunkId))
					const scratchBuffer = this.createScratchBuffer()
					const currentTick = 5

					// 2. Action: Fire events
					this.entityMaskManager.fireEventById(damagedMaskId, realEntities[1], currentTick) 

					// 3. Verification
					const changedCount = this.entityMaskManager.getEventIndicesSince(damagedMaskId, chunkId, 4, 5, scratchBuffer)
					expect(changedCount).toBe(1)
					expect(scratchBuffer[0]).toBe(1) // Entity at index 1
				})

				it('should be quiet on subsequent ticks if no new events are fired', () => {
					cleanup()
					const allocationRule = { with: [componentA] }
					const damagedMaskId = this.entityMaskManager.createEventMask('bitmask_test:damaged_quiet', allocationRule)
					const { payload } = this.compile({ componentA: {} })
					this.createEntity(payload)
					flush()

					const query = this.getQuery({ with: [componentA] })
					const entityId = query.getSingleEntity()
					const chunkId = query.getChunks()[0]
					const scratchBuffer = this.createScratchBuffer()

					// Fire event at tick 10
					this.entityMaskManager.fireEventById(damagedMaskId, entityId, 10) 

					// Verify it's found when querying for tick 10
					let changedCount = this.entityMaskManager.getEventIndicesSince(damagedMaskId, chunkId, 9, 10, scratchBuffer)
					expect(changedCount).toBe(1)

					// Verify it's NOT found when querying for tick 11
					changedCount = this.entityMaskManager.getEventIndicesSince(damagedMaskId, chunkId, 10, 11, scratchBuffer)
					expect(changedCount).toBe(0)
				})

				it('should aggregate events over a multi-tick window', () => {
					cleanup()
					const allocationRule = { with: [componentA] }
					const damagedMaskId = this.entityMaskManager.createEventMask('bitmask_test:damaged_multi', allocationRule)
					const { payload } = this.compile({ componentA: {} })
					const entities = [this.createEntity(payload), this.createEntity(payload), this.createEntity(payload)]
					flush()

					const query = this.getQuery({ with: [componentA] })
					const chunkIds = query.getChunks()
					expect(chunkIds.length).toBe(1)
					const chunkId = chunkIds[0]
					const realEntities = this.getEntities(chunkId).slice(0, this.getChunkSize(chunkId))
					const scratchBuffer = this.createScratchBuffer()

					// Fire events across multiple ticks
					this.entityMaskManager.fireEventById(damagedMaskId, realEntities[0], 20) 
					this.entityMaskManager.fireEventById(damagedMaskId, realEntities[2], 22) 
					this.entityMaskManager.fireEventById(damagedMaskId, realEntities[0], 22) // Duplicate event, should be aggregated 

					// Query over the whole window
					const changedCount = this.entityMaskManager.getEventIndicesSince(damagedMaskId, chunkId, 19, 22, scratchBuffer)
					expect(changedCount).toBe(2)
					const changedIndices = Array.from(scratchBuffer.slice(0, changedCount)).sort()
					expect(changedIndices).toEqual([0, 2])
				})

				it('should preserve event history when an entity moves to a new chunk', () => {
					cleanup()

					// 1. Setup
					const allocationRule = { with: [componentA] }
					const damagedMaskId = this.entityMaskManager.createEventMask('bitmask_test:event_move', allocationRule)
					const { payload: creationPayload } = this.compile({ componentA: {} })
					this.createEntity(creationPayload)
					flush()

					const query = this.getQuery({ with: [componentA] })
					const entityId = query.getSingleEntity()
					const oldLocation = this.getEntityLocation(entityId)
					const scratchBuffer = this.createScratchBuffer()

					// 2. Fire an event in the old chunk
					this.entityMaskManager.fireEventById(damagedMaskId, entityId, 10)

					// Verify it's found in the old chunk
					let changedCount = this.entityMaskManager.getEventIndicesSince(damagedMaskId, oldLocation.chunkId, 9, 10, scratchBuffer)
					expect(changedCount).toBe(1, 'Event should be detected in the original chunk')
					expect(scratchBuffer[0]).toBe(oldLocation.indexInChunk)

					// 3. Force an archetype move by adding a component
					const { payload: addPayload } = this.compile(componentB, {})
					this.addComponent(entityId, addPayload)
					flush()

					// 4. Verification
					const newLocation = this.getEntityLocation(entityId)
					expect(newLocation).toBeDefined()
					expect(newLocation.chunkId).not.toBe(oldLocation.chunkId, 'Entity should have moved to a new chunk')

					// The event history should have been copied to the new chunk's mask
					changedCount = this.entityMaskManager.getEventIndicesSince(damagedMaskId, newLocation.chunkId, 9, 10, scratchBuffer)
					expect(changedCount).toBe(1, 'Event history should be preserved after moving chunks')
					expect(scratchBuffer[0]).toBe(newLocation.indexInChunk)
				})

				it('should correctly handle history ring buffer overflow', async () => {
					cleanup()
					const allocationRule = { with: [componentA] }
					// Use a small history (4) for easier testing 
					this.ringBufferTestDamagedMaskId = this.entityMaskManager.createEventMask('bitmask_test:damaged_overflow', allocationRule, 4)
					const { payload } = this.compile({ componentA: {} })
					this.createEntity(payload)
					flush()
					const query = this.getQuery({ with: [componentA] })
					this.ringBufferTestChunkId = query.getChunks()[0]

					// The update method will drive the rest of this test.
					await new Promise(resolve => {
						this.ringBufferTestResolve = resolve
					})
				})
			})
		})

		// Run all the defined tests
		setTimeout(() => testManager.runAllTests(), 500) // Increased delay to allow for multiple ticks
	}

	update({ currentTick, lastTick }) {
		// --- Ring Buffer Overflow Test State Machine ---
		if (this.ringBufferTestResolve) {
			const query = this.getQuery({ with: [componentA] })
			const entityId = query.getSingleEntity()
			const chunkId = this.ringBufferTestChunkId
			const damagedMaskId = this.ringBufferTestDamagedMaskId
			const scratchBuffer = this.createScratchBuffer()

			switch (this.ringBufferTestPhase) {
				case 'INIT':
					// Wait for the entity to be created and the chunk to be ready.
					if (!entityId || !chunkId) return

					// Fire an event at an early tick (e.g., currentTick + 1)
					this.entityMaskManager.fireEventById(damagedMaskId, entityId, currentTick + 1) 
					this.ringBufferTestPhase = 'WAIT_FOR_OVERFLOW'
					break

				case 'WAIT_FOR_OVERFLOW':
					// We need to advance the game loop enough times for the maintenance job
					// to clear the original event's slot in the ring buffer.
					// historyLength is 4. We fired at currentTick + 1.
					// We need to query at (currentTick + 1) + historyLength + some_buffer.
					// Let's say we fire at tick 5. History is 4.
					// Tick 5 (index 1) has event.
					// Tick 6 (index 2) maintenance clears slot for tick 7 (index 3).
					// Tick 7 (index 3) maintenance clears slot for tick 8 (index 0).
					// Tick 8 (index 0) maintenance clears slot for tick 9 (index 1).
					// So, by tick 8, the original event at tick 5 (index 1) should be cleared by maintenance for tick 9.
					// We query at tick 9 for events since tick 4.
					
					const eventTick = lastTick + 1 // The tick the event was fired on
					const historyLength = this.entityMaskManager.getMaskSetInfo(damagedMaskId).historyLength
					const queryTick = eventTick + historyLength + 1 // Query after enough ticks have passed

					if (currentTick >= queryTick) {
						const changedCount = this.entityMaskManager.getEventIndicesSince(
							damagedMaskId,
							chunkId,
							eventTick - 1,
							queryTick,
							scratchBuffer,
						)
						expect(changedCount).toBe(
							0,
							`Event fired at tick ${eventTick} should have aged out of the ring buffer by tick ${queryTick}`,
						)
						this.ringBufferTestPhase = 'COMPLETE'
						this.ringBufferTestResolve()
					}
					break

				case 'COMPLETE':
					// Test finished.
					break
			}
		}
	}

	destroy() {
		// On HMR, clear the previously registered tests from the TestManager
		testManager.clear()
	}
}
