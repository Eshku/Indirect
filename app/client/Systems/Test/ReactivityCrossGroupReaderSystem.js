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
	}

	update({ frameCounter }) {
		if (this.testComplete) return

		this.testEntityId = this.entityQuery.getSingleEntity()

		if (!this.testEntityId) return // Wait for the writer system to create it

		const entityLocation = ecs.getEntityLocation(this.testEntityId)
		if (!entityLocation) return
		//entity exist

		const { chunkId } = entityLocation
		const reactivity = this.getComponentData(chunkId, reactivityComponent)
		const currentValue = reactivity.value[entityLocation.indexInChunk]

		// For logging purposes, we can get the current version directly from the game loop.
		const currentVersion = ecs.systemManager.gameLoop.globalVersion

		console.log(`READER LOGS:`)

		console.log(
			`Frame ${frameCounter}: Found entity with reactivity value ${currentValue} on Version ${currentVersion}`,
		)

		this.foundOnVersion = currentVersion

		// The writer system (Logic group) ran at frame tick `T` and marked the component
		// dirty with a timestamp of `T`.
		// This reader system (Visuals group) runs later in the same frame. Its context is:
		// - `lastTick` = `T-1` (the tick of the *frame* it last completed)
		// - `currentTick` = `T+N` (the latest global tick after the logic loop)
		// The reactive query looks for changes in the range `(lastTick, currentTick]`, which is `(T-1, T+N]`.
		// The change timestamped `T` is correctly detected. We check for it as soon as we see the value change.

		const changedChunks = this.reactiveQuery.getChunks()
		if (changedChunks > 0) {
			this.broadPhaseFoundTick = currentVersion
		}
		//! MUST DETECT CHANGE AS SOON AS CHANGE MADE

		console.log(`Changed chunks (Broad Phase):`)
		console.log(changedChunks)

		/* 		console.log(`Current value: ${currentValue}`)
		console.log(`Current version: ${currentVersion}`) */

		const dirtyCount = this.getDirty(chunkId, reactivityComponent, this.scratchBuffer)
		if (dirtyCount > 0) {
			this.narrowPhaseFoundVersion = currentVersion
		}
		console.log(`Entity Dirty Count (Narrow Phase): ${dirtyCount}`)

		//! Quiet check next frame will be added later.

		//something like

		if (currentVersion === this.foundOnVersion + 1) {
			const changedChunks = this.reactiveQuery.getChunks()
			const dirtyCount = this.getDirty(chunkId, reactivityComponent, this.scratchBuffer)

			console.log(`Next Frame found:`)
			console.log(`Chunks:`)
			console.log(changedChunks)
			console.log(`Entities:`)
			console.log(dirtyCount)

			this.testComplete = true
			//if implementation is correct we should stop there, that is last silent check when entity is created + 1 frame.

		}
	}

	destroy() {
		if (this.testEntityId) {
			ecs.destroyEntity(this.testEntityId)
		}
	}
}
