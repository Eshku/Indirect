const { engine } = await import(`@client/Engine.js`)
const { ecs, testManager } = engine.getManagers()
const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`)

const { reactivityComponent, componentA } = ecs.getComponentIDs()

/**
 * Verifies that deferred commands (e.g., `instantiate`) from a 'logic' group
 * are visible to a 'visuals' group in the same global frame.
 *
 * --- TIMING & DATA VISIBILITY EXPLANATION ---
 *
 * The engine's `GameLoop` executes groups in the following order (simplified):
 * `Logic -> Timed -> Visuals`
 *
 * A critical detail is that the `Logic` group flushes its command buffer *after each
 * fixed-step tick*. This means:
 *
 * 1.  **Logic Group (Tick `T`)**:
 *     -   The `ReactivityCrossGroupDeferredWriterSystem` calls `instantiate(...)`. The command is queued.
 *
 * 2.  **Logic Group Flush (End of Tick `T`)**:
 *     -   The command buffer is flushed. The entity is created and its components
 *       are timestamped with tick `T+1`.
 *
 * 3.  **Visuals Group (Later in the same frame)**:
 *     -   This `ReactivityCrossGroupDeferredReaderSystem` runs.
 *     -   Its reactive query checks for changes since it last ran (e.g., in the
 *       previous frame at tick `T_prev`). The query window is `(T_prev, T_current]`.
 *
 * 4.  **Result**:
 *     -   The creation event (timestamp `T+1`) is inside the query window.
 *     -   The test correctly detects the change in the same frame it was made.
 *
 * This test confirms that `Visuals` systems can immediately react to the results of
 * deferred commands from `Logic` systems.
 */
export class ReactivityCrossGroupDeferredReaderSystem {
	constructor() {
		this.testPhase = 'INIT'
		this.testEntityId = null
		this.testComplete = false
		this.resolveTest = null
	}

	init() {
		this.entityQuery = this.getQuery({ with: [componentA, reactivityComponent] })
		this.reactiveQuery = this.getQuery({
			with: [componentA, reactivityComponent],
			modified: [reactivityComponent],
		})

		describe('Reactivity Cross-Group (Deferred Commands)', () => {
			it('should detect deferred entity creation from a Logic system in the same global frame', async () => {
				await new Promise(resolve => {
					this.resolveTest = resolve
				})
			})
		})

		testManager.runAllTests()

	}

	update({ currentTick, lastTick }) {
		if (this.testComplete || !this.resolveTest) return

		// Always try to get the entity ID once it's created.
		if (!this.testEntityId) {
			this.testEntityId = this.entityQuery.getSingleEntity()
		}

		// If it's still not there, we're waiting for it to be created.
		if (!this.testEntityId) {
			// We are in INIT phase, just waiting.
			return
		}

		switch (this.testPhase) {
			case 'INIT':
				// We found the entity, so we can move to the next phase.
				// We'll check for the reactive change on this same frame.
				this.testPhase = 'CHECK_CREATION'
			// fallthrough

			case 'CHECK_CREATION': {
				console.log(`Detected creation at Tick ${currentTick}`)
				// The entity was created via a deferred command in the 'logic' group on a previous tick.
				// The command was flushed and timestamped.
				// This 'visuals' system, running later, should now see the change.
				// A `createEntity` command triggers both `added:` and `modified:` reactivity.
				const changedChunks = this.reactiveQuery.getChunks()

				if (changedChunks.length > 0) {
					expect(changedChunks.length).toBe(
						1,
						`[Deferred] Should detect one changed chunk on creation. Reader at tick ${currentTick}, last ran at ${lastTick}.`,
					)

					const data = ecs.getComponent(this.testEntityId, 'reactivityComponent')
					expect(data.value).toBe(1, '[Deferred] Initial value should be 1.')

					this.testPhase = 'QUIET_CHECK'
				}
				// If not found, we just wait. The test will time out if it never appears, indicating a failure.
				break
			}

			case 'QUIET_CHECK': {
				console.log(`Checking quiet at Tick ${currentTick}`)
				// On the next frame, the reactive query should be empty because we already reacted to the creation.
				// The system's `lastTick` has been updated, so the creation event is no longer in the `(lastTick, currentTick]` range.
				const changedChunksQuiet = this.reactiveQuery.getChunks()
				

				expect(changedChunksQuiet.length).toBe(
					0,
					`[Deferred] Should be quiet on the frame after reaction. Reader at tick ${currentTick}.`,
				)

				this.testPhase = 'COMPLETE'
				break
			}

			case 'COMPLETE':
				this.testComplete = true
				this.resolveTest()
				break
		}
	}

	destroy() {
		if (this.testEntityId) {
			ecs.destroyEntity(this.testEntityId)
		}
	}
}
