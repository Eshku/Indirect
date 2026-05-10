const { engine } = await import(`@client/Engine.js`)
const { ecs, testManager } = engine.getManagers()
const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`)

const { reactivityComponent, reactivityTarget } = ecs.getComponentIDs()
/**
 * A test system that runs in the Visuals group and reads changes made by
 * the ReactivityCrossGroupWriterSystem, which runs in the Logic group.
 *
 * --- EXPECTED BEHAVIOR: SAME-FRAME, CROSS-GROUP REACTIVITY ---
 *
 * This test verifies a critical engine feature: the ability for a system in one
 * group (e.g., 'Visuals') to react to a "direct write" (`mark...Dirty`) made by a
 * system in a preceding group (e.g., 'Logic') within the same global frame.
 *
 * The timing is as follows:
 *
 * 1.  **Frame `F` Starts**: The global `GameLoop.currentTick` is, for example, `T`.
 *
 * 2.  **Logic Group Runs**:
 *     -   The `ReactivityCrossGroupWriterSystem` runs.
 *     -   It receives `currentTick = T` in its context.
 *     -   It calls `markComponentDirty(..., T)`, timestamping the change with the current tick, `T`.
 *
 * 3.  **Logic Group Finishes**:
 *     -   The `GameLoop` may execute one or more fixed logic steps, incrementing the
 *       global `currentTick` to `T+1` (or more).
 *
 * 4.  **Visuals Group Runs (Later in Frame `F`)**:
 *     -   The `ReactivityCrossGroupReaderSystem` runs.
 *     -   Its `lastTick` context is `T-1` (the tick of the *frame* it last completed).
 *     -   Its `currentTick` context is `T+1` (the *latest* global tick).
 *
 * 5.  **Reactivity Check**:
 *     -   A reactive query (`modified:`) or a `getDirty()` call checks for changes
 *       in the tick range `(lastTick, currentTick]`, which is `(T-1, T+1]`.
 *     -   The change timestamped with `T` falls within this range.
 *     -   **Result**: The change is correctly detected, and the test passes.
 *
 * This model ensures that direct writes are visible immediately to subsequent
 * groups, enabling powerful patterns like logic systems flagging entities for
 * visual systems to process in the same frame.
 */

export class ReactivityCrossGroupReaderSystem {
	constructor() {
		this.testPhase = 'INIT'
		this.testEntityId = null
		this.testComplete = false
		this.resolveTest = null // Initialize to null
		this.lastValue = -1
	}

	init() {
		// Reactive query to detect changes in reactivityComponent
		this.reactiveQuery = this.getQuery({
			with: [reactivityTarget, reactivityComponent],
			modified: [reactivityComponent],
		})

		// Non-reactive query to read the entity's current state
		this.entityQuery = this.getQuery({
			with: [reactivityTarget, reactivityComponent],
		})

		this.scratchBuffer = this.createScratchBuffer()

		describe('Reactivity Cross-Group (Direct Writes)', () => {
			it('should detect direct writes from a Logic system in the same global frame when timestamped correctly', async () => {
				await new Promise(resolve => {
					this.resolveTest = resolve
				})
			})
		})

		testManager.runAllTests()
	}

	update({ currentTick, lastTick }) {

		if (this.testComplete) return

		// Wait for the test promise to be set up by the test manager
		if (this.testPhase === 'INIT' && !this.resolveTest) {
			// The test manager hasn't run the 'it' block yet to assign resolveTest.
			// Keep waiting in the 'INIT' phase until it's ready.
			return
		}

		this.testEntityId = this.entityQuery.getSingleEntity()

		if (!this.testEntityId) return // Wait for the writer system to create it

		const entityLocation = ecs.getEntityLocation(this.testEntityId)
		if (!entityLocation) return

		const { chunkId } = entityLocation
		const reactivity = this.getComponentData(chunkId, reactivityComponent)
		const currentValue = reactivity.value[entityLocation.indexInChunk]

		switch (this.testPhase) {
			case 'INIT':
				// The writer system (Logic group) ran at frame tick `T` and marked the component
				// dirty with a timestamp of `T`.
				// This reader system (Visuals group) runs later in the same frame. Its context is:
				// - `lastTick` = `T-1` (the tick of the *frame* it last completed)
				// - `currentTick` = `T+N` (the latest global tick after the logic loop)
				// The reactive query looks for changes in the range `(lastTick, currentTick]`, which is `(T-1, T+N]`.
				// The change timestamped `T` is correctly detected. We check for it as soon as we see the value change.

				const changedChunks = this.reactiveQuery.getChunks()

				// On the first frame, the logic group may not have run yet. We only run assertions
				// once a change is actually detected to make the test robust.
				if (changedChunks.length > 0) {
					expect(changedChunks.length).toBe(
						1,
						`[Cross-Group] Broad-phase: Expected 1 changed chunk. Reader at tick ${currentTick}.`,
					)

					const dirtyCount = this.getDirty(chunkId, reactivityComponent, lastTick, currentTick, this.scratchBuffer)
					expect(dirtyCount).toBe(
						1,
						`[Cross-Group] Narrow-phase: Expected 1 dirty entity. Reader at tick ${currentTick}.`,
					)
					expect(this.scratchBuffer[0]).toBe(entityLocation.indexInChunk)

					this.lastValue = currentValue
					this.testPhase = 'QUIET_CHECK'
				}
				break

			case 'QUIET_CHECK':
				// On this frame, the reactive query should be empty because we already reacted.
				const changedChunksQuiet = this.reactiveQuery.getChunks()

				expect(changedChunksQuiet.length).toBe(
					0,
					`[Cross-Group] Broad-phase: Should be quiet on the frame after reaction. Reader at tick ${currentTick}.`,
				)

				this.testPhase = 'COMPLETE'
				break


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
