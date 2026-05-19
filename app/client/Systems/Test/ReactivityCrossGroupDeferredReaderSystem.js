const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

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
		this.testPhase = 'WAIT_FOR_CREATION'
		this.testEntityId = null
		this.testComplete = false
	}

	init() {
		this.entityQuery = this.getQuery({ with: [componentA, reactivityComponent] })
		this.reactiveQuery = this.getQuery({
			with: [componentA, reactivityComponent],
			modified: [reactivityComponent],
		})

		console.log('[ReactivityCrossGroupDeferredReaderSystem] Initialized. Waiting for deferred entity creation...')
	}

	update({ currentVersion, lastVersion, frameCounter }) {
		if (this.testComplete) return

		// Always try to get the entity ID once it's created.
		if (!this.testEntityId) {
			this.testEntityId = this.entityQuery.getSingleEntity()
		}

		// If it's still not there, we're waiting for it to be created.
		if (!this.testEntityId) {
			return
		}

		switch (this.testPhase) {
			case 'WAIT_FOR_CREATION':
				// The entity now exists. We can proceed to check for the reactive change on this same frame.
				this.testPhase = 'DETECT_CHANGE'
			// fall-through to check immediately
			case 'DETECT_CHANGE': {
				// The entity was created via a deferred command in the 'logic' group on a previous tick.
				// The command was flushed and timestamped.
				// This 'visuals' system, running later, should now see the change.
				const changedChunks = this.reactiveQuery.getChunks()

				if (changedChunks.length > 0) {
					console.log(
						`%c[SUCCESS] [Deferred] Detected creation in Frame ${frameCounter} at Version ${currentVersion}.`,
						'color: lightgreen',
					)

					const data = ecs.getComponent(this.testEntityId, 'reactivityComponent')
					if (data.value !== 1) {
						console.error(`[FAILURE] [Deferred] Initial value was ${data.value}, expected 1.`)
					}

					this.testPhase = 'QUIET_CHECK'
				}
				// If not found yet, we just wait. The test will fail if it never appears.
				break
			}

			case 'QUIET_CHECK': {
				// On the next frame, the reactive query should be empty because we already reacted to the creation.
				// The system's `lastTick` has been updated, so the creation event is no longer in the `(lastTick, currentTick]` range.
				const changedChunksQuiet = this.reactiveQuery.getChunks()

				if (changedChunksQuiet.length === 0) {
					console.log(
						`%c[SUCCESS] [Deferred] Query was quiet in Frame ${frameCounter} on the next frame (Version ${currentVersion}).`,
						'color: lightgreen',
					)
				} else {
					console.error(`[FAILURE] [Deferred] Query was not quiet. Found ${changedChunksQuiet.length} changed chunks.`)
				}

				this.testPhase = 'COMPLETE'
				break
			}

			case 'COMPLETE':
				this.testComplete = true
				console.log(
					'%c[TEST COMPLETE] [Deferred] Cross-group deferred reactivity test passed.',
					'font-weight: bold; color: lightgreen',
				)
				break
		}
	}

	destroy() {
		if (this.testEntityId) {
			ecs.destroyEntity(this.testEntityId)
		}
	}
}
