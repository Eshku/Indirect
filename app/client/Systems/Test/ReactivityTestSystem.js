const { engine } = await import(`@client/Engine.js`)
const { ecs, testManager } = engine.getManagers()

const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`)

import { ecs as ECS } from '@managers/EntityManager/ECS.js'

const { reactivityComponent, componentA, componentB, componentC } = ecs.getTypeIDs()

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
		this.testComplete = false
		this.immediateTestComplete = false
	}

	init() {
		this.ECS = ECS

		// Define separate queries to test each reactive clause in isolation.
		this.modifiedQuery = this.getQuery({ with: [reactivityComponent], modified: [reactivityComponent] })
		this.addedQuery = this.getQuery({ with: [reactivityComponent, componentB], added: [componentB] })
		this.removedQuery = this.getQuery({ with: [reactivityComponent], removed: [componentC] })
		this.combinedQuery = this.getQuery({
			with: [reactivityComponent], // Isolate from immediate test
			modified: [reactivityComponent],
			added: [componentB],
			removed: [componentC],
		})

		// Payloads for our test operations
		this.addCompBPayload = this.compile(componentB, {}).payload

		// Queries for combined structural change tests
		this.addedCQuery = this.getQuery({ with: [reactivityComponent, componentC], added: [componentC] })
		this.removedBQuery = this.getQuery({ with: [reactivityComponent], removed: [componentB] })

		// A query to find the entity after its initial creation.
		this.initQuery = this.getQuery({ with: [reactivityComponent, componentC] })
		this.addCompCPayload = this.compile(componentC, {}).payload

		// --- Immediate Test Queries (isolated with componentA) ---
		this.immediateAddedQuery = this.getQuery({ with: [componentA, componentB], added: [componentB] })
		this.immediateRemovedQuery = this.getQuery({ with: [componentA], removed: [componentC] })
		this.immediateInitQuery = this.getQuery({ with: [componentA, componentC], added: [componentA] })

		// Run the test suite via the TestManager
		describe('Reactivity API (Deferred)', () => {
			it('should correctly react to component changes across multiple ticks', async () => {
				// This single 'it' block will be driven by the update loop.
				// We'll await a promise that resolves when the test state machine finishes.
				await new Promise(resolve => {
					this.resolveTest = resolve
				})
			})
		})

		describe('Reactivity API (Immediate Mode)', () => {
			it('should correctly react to immediate component changes across multiple ticks', async () => {
				await new Promise(resolve => {
					this.resolveImmediateTest = resolve
				})
			})
		})

		// Delay the test run to ensure the engine is fully initialized.
		setTimeout(() => testManager.runAllTests(), 100)
	}

	update({ currentTick }) {
		// Run state machines concurrently, but only if their test has been started by the test runner.
		if (this.resolveTest) {
			this._runDeferredTest()
		}
		if (this.resolveImmediateTest) {
			this._runImmediateTest()
		}
	}

	_runDeferredTest() {
		if (this.testComplete) return
		switch (this.testPhase) {
			case 'INIT':
				// On the first run, create the entity to be tested.
				// It starts with componentA and componentC.
				const { payload: creationPayload } = this.compile({
					reactivityComponent: { value: 0 },
					componentC: {},
				})
				// Queue the creation command. Don't store the placeholder, we'll find the real entity next frame.
				this.createEntity(creationPayload)
				this.testPhase = 'INIT_CHECK'
				break

			case 'INIT_CHECK':
				// The entity was created at the end of the last frame. Find it now.
				const realEntityId = this.initQuery.getSingleEntity()
				// It might not exist on the very first frame if the logic loop didn't run, so we wait.
				if (!realEntityId) break

				this.testEntityId = realEntityId
				this.testPhase = 'QUIET_CHECK'
				break

			case 'QUIET_CHECK':
				expect(this.testEntityId).toBeDefined('[Deferred] Entity should have been found in INIT_CHECK')
				// On the next tick, assert that no reactive queries match.
				// The entity exists, but no changes have occurred since the last frame.
				expect(this.modifiedQuery.getMatchingChunks().length).toBe(0, 'modifiedQuery should be empty on quiet tick')
				expect(this.addedQuery.getMatchingChunks().length).toBe(0, 'addedQuery should be empty on quiet tick')
				expect(this.removedQuery.getMatchingChunks().length).toBe(0, 'removedQuery should be empty on quiet tick')
				expect(this.combinedQuery.getMatchingChunks().length).toBe(0, 'combinedQuery should be empty on quiet tick')

				this.testPhase = 'PERFORM_MODIFICATION'
				break

			case 'PERFORM_MODIFICATION':
				// Use a command to modify componentA.
				const { payload: modificationPayload } = this.compile(reactivityComponent, { value: 1 })
				this.setComponentData(this.testEntityId, modificationPayload)
				this.testPhase = 'MODIFIED_CHECK'
				break

			case 'MODIFIED_CHECK':
				// Assert that ONLY the modified query now has results.
				expect(this.modifiedQuery.getMatchingChunks().length).toBe(1, '[Deferred] modifiedQuery should detect change')
				expect(this.addedQuery.getMatchingChunks().length).toBe(0, '[Deferred] addedQuery should be empty after modification')
				expect(this.removedQuery.getMatchingChunks().length).toBe(0, '[Deferred] removedQuery should be empty after modification')
				expect(this.combinedQuery.getMatchingChunks().length).toBe(1, '[Deferred] combinedQuery should detect modification')
				this.testPhase = 'MODIFIED_QUIET_CHECK'
				break

			case 'MODIFIED_QUIET_CHECK':
				// On the tick after a modification was detected, the query should be quiet again.
				expect(this.modifiedQuery.getMatchingChunks().length).toBe(0, '[Deferred] modifiedQuery should be quiet on the tick after reaction')
				this.testPhase = 'PERFORM_ADD'
				break

			case 'PERFORM_ADD':
				// Use a command to add componentB. This causes an archetype change.
				this.addComponent(this.testEntityId, this.addCompBPayload)
				this.testPhase = 'ADDED_CHECK'
				break

			case 'ADDED_CHECK':
				// The entity is in a new chunk. Assert that the addedQuery now matches.
				// The modifiedQuery should be empty as no modification happened this tick.
				expect(this.modifiedQuery.getMatchingChunks().length).toBe(0, '[Deferred] modifiedQuery should be empty after add')
				expect(this.addedQuery.getMatchingChunks().length).toBe(1, '[Deferred] addedQuery should detect add')
				expect(this.removedQuery.getMatchingChunks().length).toBe(0, '[Deferred] removedQuery should be empty after add')
				expect(this.combinedQuery.getMatchingChunks().length).toBe(1, '[Deferred] combinedQuery should detect add')
				this.testPhase = 'ADDED_QUIET_CHECK'
				break

			case 'ADDED_QUIET_CHECK':
				// On the tick after an add was detected, the query should be quiet again.
				expect(this.addedQuery.getMatchingChunks().length).toBe(0, '[Deferred] addedQuery should be quiet on the tick after reaction')
				this.testPhase = 'PERFORM_REMOVAL'
				break

			case 'PERFORM_REMOVAL':
				// Use a command to remove componentC. This causes another archetype change.
				this.removeComponent(this.testEntityId, componentC)
				this.testPhase = 'REMOVED_CHECK'
				break

			case 'REMOVED_CHECK':
				// The entity is in yet another chunk. Assert that the removedQuery now matches.
				expect(this.modifiedQuery.getMatchingChunks().length).toBe(0, '[Deferred] modifiedQuery should be empty after remove')
				expect(this.addedQuery.getMatchingChunks().length).toBe(0, '[Deferred] addedQuery should be empty after remove')
				expect(this.removedQuery.getMatchingChunks().length).toBe(1, '[Deferred] removedQuery should detect remove')
				expect(this.combinedQuery.getMatchingChunks().length).toBe(1, '[Deferred] combinedQuery should detect remove')
				this.testPhase = 'REMOVED_QUIET_CHECK'
				break

			case 'REMOVED_QUIET_CHECK':
				// On the tick after a removal was detected, the query should be quiet again.
				expect(this.removedQuery.getMatchingChunks().length).toBe(0, '[Deferred] removedQuery should be quiet on the tick after reaction')
				this.testPhase = 'PERFORM_COMBINED_ADD_REMOVE'
				break

			case 'PERFORM_COMBINED_ADD_REMOVE':
				// At this point, the entity has [reactivityComponent, componentB].
				// We will add componentC and remove componentB in the same frame.
				this.addComponent(this.testEntityId, this.addCompCPayload)
				this.removeComponent(this.testEntityId, componentB)
				this.testPhase = 'COMBINED_ADD_REMOVE_CHECK'
				break

			case 'COMBINED_ADD_REMOVE_CHECK':
				// The entity moved to a new chunk. Verify that both events were detected.
				expect(this.addedCQuery.getMatchingChunks().length).toBe(1, '[Deferred] addedCQuery should detect add of C in combined change')
				expect(this.removedBQuery.getMatchingChunks().length).toBe(1, '[Deferred] removedBQuery should detect remove of B in combined change')
				this.testPhase = 'PERFORM_MODIFY_AND_ADD'
				break

			case 'PERFORM_MODIFY_AND_ADD':
				// At this point, entity has [reactivityComponent, componentC].
				// We will modify reactivityComponent and add componentB in the same frame.
				const { payload: modAndAddPayload } = this.compile(reactivityComponent, { value: 2 })
				this.setComponentData(this.testEntityId, modAndAddPayload)
				this.addComponent(this.testEntityId, this.addCompBPayload)
				this.testPhase = 'MODIFY_AND_ADD_CHECK'
				break

			case 'MODIFY_AND_ADD_CHECK':
				// The entity moved. Both the modification and the structural change should be detected.
				expect(this.modifiedQuery.getMatchingChunks().length).toBe(1, '[Deferred] modifiedQuery should detect change during a structural move')
				expect(this.addedQuery.getMatchingChunks().length).toBe(1, '[Deferred] addedQuery (for B) should detect change during a modification')
				this.testPhase = 'PERFORM_SILENT_MODIFICATION'
				break

			case 'PERFORM_SILENT_MODIFICATION':
				// Use a silent command to modify componentA. No query should react.
				const { payload: silentPayload } = this.compile(reactivityComponent, { value: 3 })
				this.setComponentDataSilent(this.testEntityId, silentPayload)
				this.testPhase = 'SILENT_CHECK'
				break

			case 'SILENT_CHECK':
				// Assert that no queries reacted to the silent update.
				expect(this.modifiedQuery.getMatchingChunks().length).toBe(0, '[Deferred] modifiedQuery should ignore silent update')
				expect(this.addedQuery.getMatchingChunks().length).toBe(0, '[Deferred] addedQuery should be empty after silent update')
				expect(this.removedQuery.getMatchingChunks().length).toBe(0, '[Deferred] removedQuery should be empty after silent update')
				expect(this.combinedQuery.getMatchingChunks().length).toBe(0, '[Deferred] combinedQuery should ignore silent update')

				this.testPhase = 'COMPLETE'
				break

			case 'COMPLETE':
				this.testComplete = true
				this.resolveTest() // Resolve the promise in the 'it' block.
				break
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
				this.immediateTestPhase = 'IMMEDIATE_QUIET_CHECK'
				break

			case 'IMMEDIATE_QUIET_CHECK':
				// On the next tick, the creation should be detected.
				expect(this.immediateInitQuery.getMatchingChunks().length).toBe(
					1,
					'[Immediate] immediateInitQuery should detect initial creation',
				)
				// Now that we've found it, update the ID to the real one.
				this.immediateTestEntityId = this.immediateInitQuery.getSingleEntity()
				expect(this.immediateTestEntityId).toBeDefined()
				this.immediateTestPhase = 'IMMEDIATE_ADD'
				break

			case 'IMMEDIATE_ADD':
				// Add componentB immediately.
				this.ECS.addComponent(this.immediateTestEntityId, 'componentB', {})
				this.immediateTestPhase = 'IMMEDIATE_ADD_CHECK'
				break

			case 'IMMEDIATE_ADD_CHECK':
				// On the next tick, check that the `added` query for componentB fired.
				expect(this.immediateAddedQuery.getMatchingChunks().length).toBe(1, '[Immediate] immediateAddedQuery should detect immediate add')
				this.immediateTestPhase = 'IMMEDIATE_REMOVE'
				break

			case 'IMMEDIATE_REMOVE':
				// Remove componentC immediately.
				this.ECS.removeComponent(this.immediateTestEntityId, 'componentC')
				this.immediateTestPhase = 'IMMEDIATE_REMOVE_CHECK'
				break

			case 'IMMEDIATE_REMOVE_CHECK':
				// On the next tick, check that the `removed` query for componentC fired.
				expect(this.immediateRemovedQuery.getMatchingChunks().length).toBe(1, '[Immediate] immediateRemovedQuery should detect immediate remove')
				this.immediateTestPhase = 'IMMEDIATE_COMPLETE'
				break

			case 'IMMEDIATE_COMPLETE':
				this.immediateTestComplete = true
				this.resolveImmediateTest()
				break
		}
	}

	destroy() {
		// Clean up entities created by this test system to prevent accumulation on HMR.
		if (this.testEntityId) {
			this.destroyEntity(this.testEntityId)
			this.flush() // Ensure deferred destruction is executed immediately for HMR.
		}
		if (this.immediateTestEntityId) {
			this.ECS.destroyEntity(this.immediateTestEntityId)
		}
		testManager.clear()
	}
}
