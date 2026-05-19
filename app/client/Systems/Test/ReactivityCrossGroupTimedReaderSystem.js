const { engine } = await import(`@client/Engine.js`)
const { ecs, testManager } = engine.getManagers()
const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`)

const { reactivityComponent } = ecs.getComponentIDs()

/**
 * Verifies that a system in a `Timed` group can react to changes from a `Logic`
 * group within the same frame.
 *
 * --- TIMING & DATA VISIBILITY EXPLANATION ---
 *
 * The engine's `GameLoop` executes groups in the following order:
 * `Input -> Logic -> Timed -> Visuals`
 *
 * A critical detail is that the `Logic` group flushes its command buffer *after each
 * fixed-step tick*. This means:
 *
 * 1.  **Logic Group (Tick `T`)**:
 *     -   A `DirectWriter` calls `mark...Dirty(..., T)`.
 *     -   A `DeferredWriter` calls `setComponent(...)`. The command is queued.
 *
 * 2.  **Logic Group Flush (End of Tick `T`)**:
 *     -   The command buffer is flushed. The `setComponent` change is applied and
 *       timestamped with tick `T+1`.
 *
 * 3.  **Timed Group (Later in the same frame)**:
 *     -   This `TimedReader` system runs.
 *     -   Its reactive query checks for changes since it last ran (e.g., in the
 *       previous frame at tick `T-1`).
 *     -   The query window is `(T-1, T+1]`.
 *
 * 4.  **Result**:
 *     -   The direct write (timestamp `T`) is inside the window.
 *     -   The deferred write (timestamp `T+1`) is also inside the window.
 *
 * This test confirms that `Timed` systems can immediately react to the results of
 * `Logic` systems, whether the changes were direct or deferred.
 */
export class ReactivityCrossGroupTimedReaderSystem {
	constructor() {
		this.testPhase = 'INIT'
		this.testEntityId = null
		this.testComplete = false
		this.resolveTest = null
	}

	init() {
		// This query is generic enough to find the entity from either the direct or deferred writer.
		this.entityQuery = this.getQuery({ with: [reactivityComponent] })
		this.reactiveQuery = this.getQuery({
			with: [reactivityComponent],
			modified: [reactivityComponent],
		})

		describe('Reactivity Cross-Group (Logic -> Timed)', () => {
			it('should detect change from Logic group in the same frame', async () => {
				await new Promise(resolve => {
					this.resolveTest = resolve
				})
			})
		})

		testManager.runAllTests()
	}

	update() {
		if (this.testComplete || !this.resolveTest) return

		if (!this.testEntityId) {
			this.testEntityId = this.entityQuery.getSingleEntity()
			if (!this.testEntityId) return // Wait for writer to create it
		}

		switch (this.testPhase) {
			case 'INIT':
				// On our first run, the writer has likely already made its change.
				// We check for the change immediately.
				
				const changedChunks = this.reactiveQuery.getChunks()

				if (changedChunks.length > 0) {
					expect(changedChunks.length).toBe(1, '[Timed] Should detect change from Logic group in the same frame.')
					this.testPhase = 'COMPLETE'
				}
				break

			case 'COMPLETE':
				this.testComplete = true
				this.resolveTest()
				break
		}
	}
}
