const { engine } = await import(`@client/Engine.js`)
const { ecs, testManager } = engine.getManagers()
const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`)

import * as Schema from '@managers/ComponentManager/ComponentSchema.js'
import { ecs as ECS } from '@managers/EntityManager/ECS.js'

const { trackedTestComponent, componentA, componentB, componentC } = ecs.getComponentIDs()

/**
 * A stateful test system for the engine's core reactivity features.
 * It validates that queries with `modified`, `added`, and `removed` clauses
 * correctly identify changes across multiple frames.
 */
export class ReactivityTestSystem {
	constructor() {
		this.testPhase = 'INIT'
		this.immediateTestPhase = 'INIT'
		this.testEntityId = null
		this.immediateTestEntityId = null
		this.silentTestEntityId = null
		this.poolingTestPhase = 'INIT'
		this.poolingTestEntityId = null
		this.poolingTestComplete = false
		this.silentTestPhase = 'INIT'
		this.silentTestComplete = false

		this.testComplete = false
		this.immediateTestComplete = false
	}

	init() {
		this.ECS = ECS

		// The query used for iteration is reactive, for broad-phase filtering.
		this.modifiedQuery = this.getQuery({ with: [trackedTestComponent], modified: [trackedTestComponent] })

		// A specific query to test if `added` is triggered on creation.
		this.creationAddedQuery = this.getQuery({ with: [trackedTestComponent], added: [trackedTestComponent] })

		this.addedQuery = this.getQuery({ with: [trackedTestComponent, componentA], added: [componentA] })
		this.removedQuery = this.getQuery({ with: [trackedTestComponent], removed: [componentC] })
		this.combinedQuery = this.getQuery({
			with: [trackedTestComponent], // Isolate from immediate test
			modified: [trackedTestComponent],
			added: [componentA],
			removed: [componentC],
		})

		// Payloads for our test operations
		this.addCompAPayload = this.compile({ componentA: {} })
		this.modificationPayload = this.compile({ trackedTestComponent: { value: 1 } })
		this.silentModificationPayload = this.compile({ trackedTestComponent: { value: 2 } })
		this.combinedModificationPayload = this.compile({ trackedTestComponent: { value: 3 } })

		// Queries for combined structural change tests
		this.addedCQuery = this.getQuery({ with: [trackedTestComponent, componentC], added: [componentC] })
		this.removedAQuery = this.getQuery({ with: [trackedTestComponent], removed: [componentA] })

		// A query to find the entity after its initial creation.
		this.initQuery = this.getQuery({ with: [trackedTestComponent, componentC] })
		this.addCompCPayload = this.compile({ componentC: {} })

		// --- Immediate Test Queries (isolated with componentA) ---
		this.immediateAddedQuery = this.getQuery({ with: [componentA, componentB], added: [componentB] })
		this.immediateModifiedQuery = this.getQuery({ with: [componentA], modified: [componentA] })
		this.immediateRemovedQuery = this.getQuery({ with: [componentA], removed: [componentC] })
		this.immediateInitQuery = this.getQuery({ with: [componentA, componentC], added: [componentA] })

		// --- Silent Test Queries ---
		this.silentCreationQuery = this.getQuery({ with: [trackedTestComponent], without: [componentA] })
		this.silentAddedQuery = this.getQuery({ with: [trackedTestComponent, componentA], added: [componentA] })
		this.silentModifiedQuery = this.getQuery({ with: [trackedTestComponent], modified: [trackedTestComponent] })

		// --- Pooling Test Queries & Payloads ---
		this.poolTag = componentA // Use componentA as our "isPooled" tag.
		// Add componentB as a permanent tag to isolate this test's entity.
		this.poolingTestActiveQuery = this.getQuery({ with: [trackedTestComponent, componentB], without: [this.poolTag] })
		this.poolingTestPooledQuery = this.getQuery({ with: [trackedTestComponent, componentB, this.poolTag] })
		this.poolingTestModifiedQuery = this.getQuery({
			with: [trackedTestComponent, componentB],
			without: [this.poolTag],
			modified: [trackedTestComponent],
		})

		this.setTrackedValuePayload = this.compile({ trackedTestComponent: { value: 999 } })
		this.resetTrackedValuePayload = this.compile({ trackedTestComponent: { value: 0 } })
		const poolTagName = Schema.componentNames[this.poolTag]
		this.addPoolTagPayload = this.compile({ [poolTagName]: {} })

		// Run the test suite via the TestManager
		describe('Reactivity API (Deferred)', () => {
			it('should correctly react to deferred component changes across multiple ticks', async () => {
				// This single 'it' block will be driven by the update loop.
				// We'll await a promise that resolves when the test state machine finishes.
				await new Promise(resolve => {
					this.resolveTest = resolve
				})
			})
		})

		describe('Reactivity API (Immediate Mode)', () => {
			it('should correctly react to immediate-mode component changes across multiple ticks', async () => {
				await new Promise(resolve => {
					this.resolveImmediateTest = resolve
				})
			})
		})

		describe('Reactivity API (Silent Operations)', () => {
			it('should not trigger reactivity for silent commands', async () => {
				await new Promise(resolve => {
					this.resolveSilentTest = resolve
				})
			})
		})

		describe('Reactivity API (Pooling Simulation)', () => {
			it('should correctly reset state on reactivation from pool', async () => {
				await new Promise(resolve => {
					this.resolvePoolingTest = resolve
				})
			})
		})

		describe('Reactivity API (Structural Change & Swapping)', () => {
			it('should preserve dirty flags on swapped entities during a structural change', async () => {
				// This test specifically targets a bug where a deferred `addComponent`
				// causes a swap that loses the dirty flag of the swapped entity.

				// A full reset is crucial for test isolation to prevent stale state from
				// other tests (like different chunk capacities) from causing errors.
				ecs.destroyAll()
				// After a full reset, we must re-register the declarative masks.
				ecs.entityMaskManager.registerDeclarativeMasks()
				this.flush()

				// Get the current version from the game loop to make the test realistic.
				const lastVersionBeforeAction = ecs.systemManager.gameLoop.globalVersion
				const versionOfAction = lastVersionBeforeAction + 1

				// 1. Setup: Create two entities in the same chunk.
				const payload = this.compile({ trackedTestComponent: { value: 0 } })
				this.instantiate(payload, 1) // This will be at index 0, the one we move.
				this.instantiate(payload, 1) // This will be at index 1, the one we swap and test.
				this.flush(versionOfAction) // Flush with a version to ensure consistency

				// Make the query specific to the archetype *before* the structural change.
				const query = this.getQuery({ with: [trackedTestComponent], without: [componentA] })
				const chunkIds = query.getChunks()
				expect(chunkIds.length).toBe(1, 'Expected all test entities to be in a single chunk.')
				const chunkId = chunkIds[0]

				// Ensure we have the correct number of entities before proceeding.
				const initialSize = this.getChunkSize(chunkId)
				expect(initialSize).toBe(2, 'Chunk should contain exactly 2 entities before the test action.')

				const entities = this.getEntities(chunkId) // Correctly get entities from the chunk
				const entityToMove = entities[0] // Entity at index 0
				const entityToSwapAndTest = entities[1] // Entity at index 1

				// 2. Action: Mark the entity that will be swapped as dirty.
				// Then, in the same frame, trigger a structural change on the *other* entity.
				ecs.entityManager.markEntityDirtyById(entityToSwapAndTest, trackedTestComponent, versionOfAction)
				this.addComponent(entityToMove, this.addCompAPayload)
				this.flush(versionOfAction)

				// 3. Verification: The `addComponent` moved entityToMove. entityToSwapAndTest was
				// swapped into its place (index 0). The dirty flag must be preserved.

				// The verification must use the narrow-phase API (`getDirty`) because the test
				// only used the narrow-phase marking API (`markEntityDirtyById`). The broad-phase
				// `modified:` query will not find this change, which is expected behavior.

				// The original chunk still exists and contains the swapped entity.
				const finalChunkIds = query.getChunks()
				expect(finalChunkIds.length).toBe(1, 'The original chunk should still exist and match the query.')
				expect(finalChunkIds[0]).toBe(chunkId, 'The chunk ID should be the same.')

				const scratchBuffer = this.createScratchBuffer()
				const dirtyCount = ecs.entityManager.getDirty(
					chunkId,
					trackedTestComponent,
					lastVersionBeforeAction,
					versionOfAction,
					scratchBuffer,
				)
				expect(dirtyCount).toBe(1, 'Narrow-phase should find the dirty swapped entity in its original chunk')
				expect(scratchBuffer[0]).toBe(0, 'The dirty entity should now be at index 0 after the swap')
			})

			it('should preserve a dirty flag when an unrelated setComponent is processed in the same frame', async () => {
				// This test simulates a system directly marking an entity dirty (like HealthSystem),
				// while another system queues a `setComponent` command for a different entity
				// in the same frame (like CursorSystem). It ensures the deferred command
				// processing doesn't interfere with the immediate dirty flag.
				ecs.destroyAll()
				// After a full reset, we must re-register the declarative masks.
				ecs.entityMaskManager.registerDeclarativeMasks()
				this.flush()

				const lastVersionBeforeAction = ecs.systemManager.gameLoop.globalVersion
				const versionOfAction = lastVersionBeforeAction + 1

				// 1. Setup: Create two entities in the same chunk.
				const payload = this.compile({ trackedTestComponent: { value: 0 } })
				this.instantiate(payload, 1) // This will be entity A,
				this.instantiate(payload, 1) // This will be entity B
				this.flush()

				const query = this.getQuery({ with: [trackedTestComponent] })
				const chunkId = query.getChunks()[0]
				const entities = this.getEntities(chunkId)
				const entityA_toMark = entities[0]
				const entityB_toSet = entities[1]

				// 2. Action: Mark entity A dirty directly. Queue a setComponent for entity B.
				ecs.entityManager.markEntityDirtyById(entityA_toMark, trackedTestComponent, versionOfAction)

				const setPayload = this.compile({ trackedTestComponent: { value: 99 } })
				this.setComponent(entityB_toSet, setPayload)

				// 3. Flush commands.
				this.flush(versionOfAction)

				// 4. Verification: Check for dirty entities in the next "tick".
				const scratchBuffer = this.createScratchBuffer()
				const dirtyCount = ecs.entityManager.getDirty(chunkId, trackedTestComponent, lastVersionBeforeAction, versionOfAction, scratchBuffer)

				// We expect 2 dirty entities: one from markEntityDirtyById, one from setComponent.
				expect(dirtyCount).toBe(2, 'Should find both the directly marked and the setComponent-marked entities')
			})
		})


		testManager.runAllTests()
	}

	update() {
		// Run state machines concurrently, but only if their test has been started by the test runner.
		if (this.resolveTest) {
			this._runDeferredTest()
		}
		if (this.resolveImmediateTest) {
			this._runImmediateTest()
		}
		if (this.resolvePoolingTest) {
			this._runPoolingTest()
		}
		if (this.resolveSilentTest) {
			this._runSilentTest()
		}
	}

	_runPoolingTest(lastVersion, currentVersion) {
		if (this.poolingTestComplete) return

		switch (this.poolingTestPhase) {
			case 'INIT': {
				// Create an entity with a non-zero value to simulate a projectile that has flown some distance.
				const payload = this.compile({
					trackedTestComponent: { value: 12345 },
					componentB: {}, // Add the permanent tag for isolation.
				})
				this.instantiate(payload, 1)
				this.poolingTestPhase = 'INIT_CHECK'

				break
			}

			case 'INIT_CHECK': {
				// Find the entity and verify its initial state.
				const entityId = this.poolingTestActiveQuery.getSingleEntity()

				this.poolingTestEntityId = entityId
				const data = this.ECS.getComponent(this.poolingTestEntityId, 'trackedTestComponent')
				expect(data.value).toBe(12345, '[PoolingTest] Initial value should be 12345')

				this.poolingTestPhase = 'DEACTIVATE'
				break
			}

			case 'DEACTIVATE': {
				// "Pool" the entity by adding the tag component. This is a structural change.
				this.addComponent(this.poolingTestEntityId, this.addPoolTagPayload)
				this.poolingTestPhase = 'DEACTIVATE_CHECK'
				break
			}

			case 'DEACTIVATE_CHECK': {
				// The addComponent command was flushed at the end of the previous frame.
				// The entity should have moved from the active query to the pooled query.
				const pooledEntity = this.poolingTestPooledQuery.getSingleEntity()
				expect(pooledEntity).toBe(
					this.poolingTestEntityId,
					'[PoolingTest] Entity should be in the pooled query after structural change',
				)

				// Verify the value is still the old, stale value.
				const pooledData = this.ECS.getComponent(this.poolingTestEntityId, 'trackedTestComponent')
				expect(pooledData.value).toBe(12345, '[PoolingTest] Pooled value should still be 12345')

				this.poolingTestPhase = 'REACTIVATE'
				break
			}

			case 'REACTIVATE': {
				this.removeComponent(this.poolingTestEntityId, this.poolTag)
				this.setComponents(this.poolingTestEntityId, this.resetTrackedValuePayload)
				this.poolingTestPhase = 'REACTIVATE_CHECK'
				break
			}

			case 'REACTIVATE_CHECK': {
				// The removeComponent and setComponents commands were flushed at the end of the previous frame.
				// The entity should now be back in the 'active' query.
				const reactivatedEntity = this.poolingTestActiveQuery.getSingleEntity()

				// Now that the structural change is complete, the entity is in the active query.
				expect(reactivatedEntity).toBe(
					this.poolingTestEntityId,
					'[PoolingTest] Entity should be in the active query after reactivation',
				)

				// Verify that the reactive query detected the change.
				const modifiedChunks = this.poolingTestModifiedQuery.getChunks()
				expect(modifiedChunks.length).toBe(
					1,
					'[PoolingTest] Reactive query should detect modification after reactivation',
				)

				// Verify the component's value was reset by the setComponents command.
				const finalData = this.ECS.getComponent(this.poolingTestEntityId, 'trackedTestComponent')
				expect(finalData.value).toBe(0, '[PoolingTest] Reactivated value should be reset to 0')

				this.poolingTestPhase = 'COMPLETE'
				break
			}

			case 'COMPLETE': {
				this.poolingTestComplete = true
				this.ECS.destroyEntity(this.poolingTestEntityId)
				this.resolvePoolingTest()
				break
			}
		}
	}

	_runDeferredTest() {
		if (this.testComplete) return
		switch (this.testPhase) {
			case 'INIT':
				// On the first run, create the entity to be tested.
				// It starts with componentA and componentC.
				const creationPayload = this.compile({
					trackedTestComponent: { value: 0 },
					componentC: {},
				})
				// Queue the creation command. Don't store the placeholder, we'll find the real entity next frame.
				this.instantiate(creationPayload, 1)
				this.testPhase = 'INIT_CHECK'
				break

			case 'INIT_CHECK':
				// The entity was created at the end of the last frame. Find it now.
				const realEntityId = this.initQuery.getSingleEntity()

				this.testEntityId = realEntityId
				const location = this.ECS.getEntityLocation(realEntityId)
				expect(location).toBeDefined()

				// Test that createEntity marks trackable components as dirty for BROAD-PHASE queries.
				// The entity was created at the end of the 'lastTick' frame. We are now in 'currentTick'.
				const createdChunks = this.modifiedQuery.getChunks()
				expect(createdChunks.length).toBe(
					1,
					'[Deferred] createEntity should mark trackable component as dirty on the creation tick (broad-phase)',
				)
				expect(createdChunks[0]).toBe(location.chunkId)

				// Verify NARROW-PHASE dirty marking on creation.

				const scratch = this.createScratchBuffer()
				const dirtyCount = this.getDirty(location.chunkId, trackedTestComponent, scratch)
				expect(dirtyCount).toBe(1, `[Deferred] createEntity should mark trackable component as dirty on the creation tick (narrow-phase).`)
				expect(scratch[0]).toBe(location.indexInChunk)

				expect(this.creationAddedQuery.getChunks().length).toBe(
					1,
					'[Deferred] createEntity should trigger `added:` query on creation tick',
				)
				this.testPhase = 'QUIET_CHECK'
				break

			case 'QUIET_CHECK':
				expect(this.testEntityId).toBeDefined('[Deferred] Entity should have been found in INIT_CHECK')
				// On the next tick, assert that no reactive queries match.
				// The entity exists, but no changes have occurred in this tick's range.
				const modifiedChunks = this.modifiedQuery.getChunks() // Already correct
				// The reactive query's broad-phase check is sufficient here.
				expect(modifiedChunks.length).toBe(0, 'modifiedQuery should be empty on quiet tick')
				expect(this.addedQuery.getChunks().length).toBe(0, 'addedQuery should be empty on quiet tick')
				expect(this.removedQuery.getChunks().length).toBe(0, 'removedQuery should be empty on quiet tick')
				expect(this.combinedQuery.getChunks().length).toBe(0, 'combinedQuery should be empty on quiet tick')

				this.testPhase = 'PERFORM_MODIFICATION'
				break

			case 'PERFORM_MODIFICATION':
				// Use the default `setComponent` which now handles dirty tracking.
				// The change will be applied at the end of this tick (`currentTick`),
				// and we will check for it in the next tick.
				this.setComponent(this.testEntityId, this.modificationPayload)
				this.testPhase = 'MODIFIED_CHECK'
				break

			case 'MODIFIED_CHECK':
				// The change happened in `lastTick`. We are now in `currentTick`.
				// 1. Broad-phase: Use the reactive query.
				const changedChunks = this.modifiedQuery.getChunks()
				expect(changedChunks.length).toBe(1, '[Deferred] Broad-phase should detect one changed chunk')

				// 2. Narrow-phase: For each changed chunk, get the specific entities that were dirty in this tick's range.
				let modifiedCountAfterChange = 0
				for (const chunkId of changedChunks) {
					modifiedCountAfterChange += this.getDirty(chunkId, trackedTestComponent, [])
				}
				expect(modifiedCountAfterChange).toBe(
					1,
					'[Deferred] Narrow-phase should find one changed entity in the dirty chunk',
				)

				expect(this.addedQuery.getChunks().length).toBe(0, '[Deferred] addedQuery should be empty after modification')
				expect(this.removedQuery.getChunks().length).toBe(
					0,
					'[Deferred] removedQuery should be empty after modification',
				)
				expect(this.combinedQuery.getChunks().length).toBe(
					1,
					'[Deferred] combinedQuery should also detect modification',
				)
				this.testPhase = 'MODIFIED_QUIET_CHECK'
				break

			case 'MODIFIED_QUIET_CHECK':
				// On the tick after a modification was detected, the broad-phase query should be quiet again.
				const modifiedChunksQuiet = this.modifiedQuery.getChunks()
				expect(modifiedChunksQuiet.length).toBe(
					0,
					'[Deferred] modifiedQuery should be quiet on the tick after reaction',
				)
				this.testPhase = 'PERFORM_ADD'
				break

			case 'PERFORM_ADD':
				// Use a command to add componentB. This causes an archetype change.
				this.addComponent(this.testEntityId, this.addCompAPayload)
				this.testPhase = 'ADDED_CHECK'
				break

			case 'ADDED_CHECK':
				// The entity is in a new chunk. Assert that the addedQuery now matches.
				expect(this.addedQuery.getChunks().length).toBe(1, '[Deferred] addedQuery should detect add')
				expect(this.removedQuery.getChunks().length).toBe(0, '[Deferred] removedQuery should be empty after add')
				expect(this.combinedQuery.getChunks().length).toBe(1, '[Deferred] combinedQuery should detect add')
				this.testPhase = 'ADDED_QUIET_CHECK'
				break

			case 'ADDED_QUIET_CHECK':
				// On the tick after an add was detected, the query should be quiet again.
				expect(this.addedQuery.getChunks().length).toBe(
					0,
					'[Deferred] addedQuery should be quiet on the tick after reaction',
				)
				this.testPhase = 'PERFORM_REMOVAL'
				break

			case 'PERFORM_REMOVAL':
				// Use a command to remove componentC. This causes another archetype change.
				this.removeComponent(this.testEntityId, componentC)
				this.testPhase = 'REMOVED_CHECK'
				break

			case 'REMOVED_CHECK':
				// The entity is in yet another chunk. Assert that the removedQuery now matches.
				expect(this.addedQuery.getChunks().length).toBe(0, '[Deferred] addedQuery should be empty after remove')
				expect(this.removedQuery.getChunks().length).toBe(1, '[Deferred] removedQuery should detect remove')
				expect(this.combinedQuery.getChunks().length).toBe(1, '[Deferred] combinedQuery should detect remove')
				this.testPhase = 'REMOVED_QUIET_CHECK'
				break

			case 'REMOVED_QUIET_CHECK':
				// On the tick after a removal was detected, the query should be quiet again.
				expect(this.removedQuery.getChunks().length).toBe(
					0,
					'[Deferred] removedQuery should be quiet on the tick after reaction',
				)
				this.testPhase = 'PERFORM_COMBINED_ADD_REMOVE'
				break

			case 'PERFORM_SILENT_MODIFICATION':
				this.setComponentsSilent(this.testEntityId, this.silentModificationPayload)
				this.testPhase = 'SILENT_CHECK'
				break
			case 'SILENT_CHECK':
				// Assert that no queries reacted to the silent update.
				const silentModChunks = this.modifiedQuery.getChunks()
				expect(silentModChunks.length).toBe(0, '[Deferred] modifiedQuery should ignore silent update')
				expect(this.addedQuery.getChunks().length).toBe(0, '[Deferred] addedQuery should be empty after silent update')
				expect(this.removedQuery.getChunks().length).toBe(
					0,
					'[Deferred] removedQuery should be empty after silent update',
				)
				expect(this.combinedQuery.getChunks().length).toBe(0, '[Deferred] combinedQuery should ignore silent update')

				this.testPhase = 'COMPLETE'
				break

			case 'PERFORM_COMBINED_ADD_REMOVE':
				// At this point, the entity has [trackedTestComponent, componentB].
				// We will add componentC and remove componentA in the same frame.
				this.addComponent(this.testEntityId, this.addCompCPayload)
				this.removeComponent(this.testEntityId, componentA)
				this.testPhase = 'COMBINED_ADD_REMOVE_CHECK'
				break

			case 'COMBINED_ADD_REMOVE_CHECK':
				// The entity moved to a new chunk. Verify that both events were detected.
				expect(this.addedCQuery.getChunks().length).toBe(1, '[Deferred] addedCQuery should detect add of C')
				expect(this.removedAQuery.getChunks().length).toBe(1, '[Deferred] removedAQuery should detect remove of A')
				this.testPhase = 'PERFORM_MODIFY_AND_ADD'
				break

			case 'PERFORM_MODIFY_AND_ADD':
				// At this point, entity has [trackedTestComponent, componentC].
				// We will modify trackedTestComponent and add componentB in the same frame.
				this.setComponent(this.testEntityId, this.combinedModificationPayload)
				this.addComponent(this.testEntityId, this.addCompAPayload)
				this.testPhase = 'MODIFY_AND_ADD_CHECK'
				break

			case 'MODIFY_AND_ADD_CHECK':
				// The entity moved. Both the modification and the structural change should be detected.
				// Broad-phase check for modification.
				const modChunks = this.modifiedQuery.getChunks()
				expect(modChunks.length).toBe(1, '[Deferred] Broad-phase should detect modification during a structural move')

				// Narrow-phase check for the modification.
				let modCount = 0
				for (const chunkId of modChunks) {
					modCount += this.getDirty(chunkId, trackedTestComponent, [])
				}
				expect(modCount).toBe(1, '[Deferred] Narrow-phase should find one modified entity during a structural move')

				// Broad-phase check for addition
				expect(this.addedQuery.getChunks().length).toBe(
					1,
					'[Deferred] addedQuery (for B) should detect change during a modification',
				)
				this.testPhase = 'COMPLETE'
				break

			case 'COMPLETE':
				this.testComplete = true
				this.ECS.destroyEntity(this.testEntityId)
				this.resolveTest() // Resolve the promise in the 'it' block.
				break
		}
	}

	_runSilentTest() {
		if (this.silentTestComplete) return

		switch (this.silentTestPhase) {
			case 'INIT': {
				// Test instantiateSilent
				const silentCreationPayload = this.compile({ trackedTestComponent: { value: 100 } })
				this.instantiateSilent(silentCreationPayload, 1)
				this.silentTestPhase = 'CHECK_SILENT_CREATION'
				break
			}

			case 'CHECK_SILENT_CREATION': {
				// The silent creation was flushed last frame.
				// Verify no reactive queries were triggered.
				expect(this.silentModifiedQuery.getChunks().length).toBe(
					0,
					'[Silent] modifiedQuery should not trigger on instantiateSilent',
				)
				expect(this.creationAddedQuery.getChunks().length).toBe(
					0,
					'[Silent] addedQuery should not trigger on instantiateSilent',
				)

				// Verify the entity was actually created.
				this.silentTestEntityId = this.silentCreationQuery.getSingleEntity()
				expect(this.silentTestEntityId).toBeDefined()
				const data = this.ECS.getComponent(this.silentTestEntityId, 'trackedTestComponent')
				expect(data.value).toBe(100)

				this.silentTestPhase = 'PERFORM_SILENT_ADD'
				break
			}

			case 'PERFORM_SILENT_ADD': {
				// Test addComponentSilent
				const silentAddPayload = this.compile({ componentA: {} })
				this.addComponentSilent(this.silentTestEntityId, silentAddPayload)
				this.silentTestPhase = 'CHECK_SILENT_ADD'
				break
			}

			case 'CHECK_SILENT_ADD': {
				// The silent add was flushed last frame.
				expect(this.silentAddedQuery.getChunks().length).toBe(0, '[Silent] addedQuery should not trigger on addComponentSilent')
				expect(this.silentModifiedQuery.getChunks().length).toBe(
					0,
					'[Silent] modifiedQuery should not trigger on addComponentSilent',
				)


				// Verify component was added.
				expect(this.ECS.hasComponent(this.silentTestEntityId, 'componentA')).toBe(true)

				this.silentTestPhase = 'PERFORM_SILENT_SET'
				break
			}

			case 'PERFORM_SILENT_SET': {
				// Test setComponentSilent (deferred)
				const silentSetPayload = this.compile({ trackedTestComponent: { value: 200 } })
				this.setComponentSilent(this.silentTestEntityId, silentSetPayload)
				this.silentTestPhase = 'CHECK_SILENT_SET'
				break
			}

			case 'CHECK_SILENT_SET': {
				// The silent set was flushed last frame.
				expect(this.silentModifiedQuery.getChunks().length).toBe(0, '[Silent] modifiedQuery should not trigger on setComponentSilent')

				// Verify data was changed.
				const setData = this.ECS.getComponent(this.silentTestEntityId, 'trackedTestComponent')
				expect(setData.value).toBe(200)

				this.silentTestPhase = 'COMPLETE'
				break
			}

			case 'COMPLETE': {
				this.silentTestComplete = true
				this.ECS.destroyEntity(this.silentTestEntityId)
				this.resolveSilentTest()
				break
			}
		}
	}

	_runImmediateTest() {
		if (this.immediateTestComplete) return

		switch (this.immediateTestPhase) {
			case 'INIT':
				this.immediateTestEntityId = this.ECS.createEntity({
					componentA: {},
					componentC: {},
				})
				this.immediateTestPhase = 'IMMEDIATE_CREATION_CHECK'
				break

			case 'IMMEDIATE_CREATION_CHECK':
				// On the next tick, the creation should be detected.
				expect(this.immediateInitQuery.getChunks().length).toBe(
					1,
					'[Immediate] immediateInitQuery should detect initial creation',
				)
				expect(this.immediateModifiedQuery.getChunks().length).toBe(
					1,
					'[Immediate] createEntity should trigger `modified:` query on creation tick',
				)
				// Now that we've found it, update the ID to the real one.
				this.immediateTestEntityId = this.immediateInitQuery.getSingleEntity()
				expect(this.immediateTestEntityId).toBeDefined()
				this.immediateTestPhase = 'IMMEDIATE_CREATION_QUIET_CHECK'
				break

			case 'IMMEDIATE_CREATION_QUIET_CHECK':
				// On the next tick, the creation queries should be quiet.
				expect(this.immediateInitQuery.getChunks().length).toBe(
					0,
					'[Immediate] immediateInitQuery should be quiet on the tick after reaction',
				)
				expect(this.immediateModifiedQuery.getChunks().length).toBe(
					0,
					'[Immediate] immediateModifiedQuery should be quiet on the tick after reaction',
				)
				this.immediateTestPhase = 'IMMEDIATE_ADD'
				break

			case 'IMMEDIATE_ADD':
				// Add componentB immediately.
				this.ECS.addComponent(this.immediateTestEntityId, 'componentB', {})
				this.immediateTestPhase = 'IMMEDIATE_ADD_CHECK'
				break

			case 'IMMEDIATE_ADD_CHECK':
				// On the next tick, check that the `added` query for componentB fired.
				expect(this.immediateAddedQuery.getChunks().length).toBe(
					1,
					'[Immediate] immediateAddedQuery should detect immediate add',
				)
				this.immediateTestPhase = 'IMMEDIATE_ADD_QUIET_CHECK'
				break

			case 'IMMEDIATE_ADD_QUIET_CHECK':
				// On the next tick, the added query should be quiet.
				expect(this.immediateAddedQuery.getChunks().length).toBe(
					0,
					'[Immediate] immediateAddedQuery should be quiet on the tick after reaction',
				)
				this.immediateTestPhase = 'IMMEDIATE_REMOVE'
				break

			case 'IMMEDIATE_REMOVE':
				// Remove componentC immediately.
				this.ECS.removeComponent(this.immediateTestEntityId, 'componentC')
				this.immediateTestPhase = 'IMMEDIATE_REMOVE_CHECK'
				break

			case 'IMMEDIATE_REMOVE_CHECK':
				// On the next tick, check that the `removed` query for componentC fired.
				expect(this.immediateRemovedQuery.getChunks().length).toBe(
					1,
					'[Immediate] immediateRemovedQuery should detect immediate remove',
				)
				this.immediateTestPhase = 'IMMEDIATE_REMOVE_QUIET_CHECK'
				break

			case 'IMMEDIATE_REMOVE_QUIET_CHECK':
				// On the next tick, the removed query should be quiet.
				expect(this.immediateRemovedQuery.getChunks().length).toBe(
					0,
					'[Immediate] immediateRemovedQuery should be quiet on the tick after reaction',
				)
				this.immediateTestPhase = 'IMMEDIATE_COMPLETE'
				break

			case 'IMMEDIATE_COMPLETE':
				this.immediateTestComplete = true
				this.ECS.destroyEntity(this.immediateTestEntityId)
				this.resolveImmediateTest()
				break
		}
	}

	destroy() {
		// Clean up entities created by this test system to prevent accumulation on HMR.
		if (this.testEntityId) {
			this.destroyEntity(this.testEntityId)
		}
		if (this.immediateTestEntityId) {
			this.ECS.destroyEntity(this.immediateTestEntityId)
		}
		if (this.silentTestEntityId) {
			this.ECS.destroyEntity(this.silentTestEntityId)
		}
		if (this.poolingTestEntityId) {
			this.destroyEntity(this.poolingTestEntityId)
		}
		this.flush() // Ensure deferred destructions are executed immediately for HMR.
		testManager.clear()
	}
}
