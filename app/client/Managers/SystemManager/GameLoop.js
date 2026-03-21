import { systemRegistry } from './SystemRegistry.js'
import { Scheduler } from './Scheduler.js'

import { ChunkView } from '../../Managers/QueryManager/ChunkView.js'

/**
 * Manages the core game loop, including fixed and variable timesteps.
 */

/**
 * --- ARCHITECTURAL NOTE on the Async Game Loop ---
 *
 * This game loop is intentionally built around a custom `requestAnimationFrame`
 * loop instead of relying on `PIXI.Ticker`. This fundamental design choice
 * allows the entire loop to be `async`, which provides critical benefits for
 * system execution and engine architecture.
 *
 * 1.  **Support for `async` Systems**: The primary benefit is the ability to
 *     `await system.update(...)`. This ensures that any asynchronous operations
 *     within a system (like asset loading in `SpriteFactorySystem`) complete
 *     fully before the next system runs or the frame ends. This resolves race
 *     conditions and makes system logic far more predictable and robust.
 *
 *
 * 2.  **"Fire-and-Forget" as an Option**: While `await` is the default, this
 *     architecture still supports non-blocking, "fire-and-forget" async
 *     operations within a system. A system can launch an async task (e.g., a
 *     network request) without `await`ing it, allowing the game loop to
 *     continue immediately.
 *
 *     **IMPORTANT**: Any "fire-and-forget" system that performs structural
 *     changes to the ECS (e.g., adding a component upon completion) MUST
 *     manage its own state carefully to prevent race conditions.
 *
 * 3.  **Future-Proofing**: This design provides a solid foundation for more
 *     advanced features like integrating Web Workers for parallelism. The loop
 *     can simply `await` a "done" message from a worker, synchronizing the
 *     main thread with background computations without freezing the application. This
 *     is explained further below.
 *
 * 4.  **Advanced Asynchronous Patterns**:
 *
 *     a. **Non-Blocking I/O (e.g., Networking)**: For long-running operations
 *        like `fetch`, a system should NOT `await` the operation directly in its
 *        `update` method, as this would freeze the game loop. Instead, it should
 *        use a "fire-and-forget" approach within the system:
 *        - An `ActionSystem` creates an entity with a `NetworkRequest` component.
 *        - A `NetworkSystem` queries for these entities, launches the `fetch` call
 *          without `await`ing it, and adds a `RequestInFlight` tag component.
 *        - On subsequent frames, it checks if the request's promise has resolved.
 *        - Upon completion, it uses the `commandBuffer` to add a `NetworkResponse`
 *          component and remove the request components.
 *
 *     b. **Parallelism with Web Workers**: To offload heavy work (e.g., physics),
 *        the `async` loop provides a clean synchronization mechanism.
 *        - The main loop would `postMessage` to a worker, telling it to begin its
 *          calculations for the current tick, using a `SharedArrayBuffer` for data.
 *        - The main loop would then immediately `await` a `Promise` that resolves only
 *          when the worker `postMessage`s back a "done" signal. This `await` is the
 *          **synchronization point**. It pauses the main loop's execution until the
 *          worker's calculations are complete, ensuring data consistency before
 *          proceeding to rendering systems.
 *
 *        - **Alternative (`Atomics.waitAsync`)**: For higher performance, instead of
 *          using `postMessage` for the return signal, the main thread can use `await
 *          Atomics.waitAsync(...)` on a specific memory address in a `SharedArrayBuffer`.
 *          The worker then calls `Atomics.notify()` on that address when done. This
 *          avoids the event system overhead and is the preferred method for tight,
 *          high-frequency synchronization loops.
 *
 *        - **`waitAsync` vs. `wait`**: It is critical to use `Atomics.waitAsync`. The
 *          synchronous version, `Atomics.wait()`, would **block the main thread**
 *          and freeze the entire application. `waitAsync`, however, only pauses the
 *          execution of the `_loop` function. It yields control back to the browser's
 *          event loop, which can continue to process rendering and user input, keeping
 *          the application responsive.
 *
 *        - Using `postMessage` with large data objects can cause stutters due to the
 *          synchronous serialization/deserialization cost (the "heavy message").
 *        - The `SharedArrayBuffer` + `Atomics` pattern has no data transfer cost. The
 *          worker modifies memory directly, and `Atomics.notify()` is a lightweight
 *          signal, not a message with a payload. This eliminates the "heavy message"
 *          bottleneck entirely.

 *     c. **Chunk-Based Parallelism**: The combination of the `async` loop, `Chunk`s, and
 *        `Atomics` creates a powerful pattern for parallelizing systems:
 *        - A `System` (e.g., `PhysicsSystem`) iterates through its query's `Chunk`s.
 *        - For each `Chunk`, it `postMessage`s the chunk's details (`startIndex`, `count`)
 *          to a free Web Worker from a pool.
 *        - The `System` then `await`s a signal from that worker. The most efficient
 *          signal is `Atomics.waitAsync` on a shared "control buffer" (a small,
 *          dedicated `SharedArrayBuffer`).
 *        - The worker performs its calculations directly on the shared component data
 *          for its assigned chunk.
 *        - When finished, the worker uses `Atomics.store` and `Atomics.notify` on the
 *          control buffer to signal completion, waking up the main thread.
 *        - This allows multiple chunks to be processed in parallel across multiple
 *          workers, with the main thread efficiently waiting for all of them to
 *          complete before moving to the next system.
 */

/**
 * --- ARCHITECTURAL NOTE on Reactivity and Ticks ---
 *
 * The engine's reactivity system is based on a simple principle:
 * a system should only react to component changes that have occurred *since the last time that system ran*.
 * This is managed through a per-group `lastTick` property and a global `currentTick`.
 *
 * The process for a given system group (e.g., 'logic') within a single game loop iteration works as follows:
 *
 * 1.  **Get Last Completed Tick**: Before executing the systems in a group, we retrieve the group's `lastTick` value.
 *     This value represents the game tick number during which the group last completed its execution.
 *     For example, if we are about to process tick 5, `logicGroup.lastTick` would be 4.
 *
 * 2.  **Execute Systems**: The `_executeSystemGroup` function is called with this `lastCompletedLogicTick`. Inside a
 *     reactive system, the check for changes is effectively `component.dirtyTick > lastCompletedLogicTick`.
 *
 * 3.  **Marking Components Dirty**: When a system modifies a component, it marks it as dirty using the *current*
 *     game loop tick (`this.currentTick`). So, any changes made during tick 5 are marked with `dirtyTick = 5`.
 *
 * 4.  **Reactivity Check**: A reactive system running later in the same tick (tick 5) will see the change because
 *     the condition `dirtyTick (5) > lastCompletedLogicTick (4)` is true. This allows for immediate **inter-system**
 *     reactivity.
 *
 * 5.  **Intra-System Reactivity**: This model also correctly handles cases where a system reacts to its own changes
 *     within the same `update()` call. For example, if a system's update logic first modifies a component (marking it
 *     dirty for the current tick, `N`) and then, later in the same call, iterates with a reactive query, the check
 *     `dirtyTick (N) > lastCompletedLogicTick (N-1)` will be true. This allows for immediate self-contained reactions.
 *
 * 6.  **Update Group's Last Tick**: After all systems in the group have run for the current tick, we update the group's
 *     `lastTick` to `this.currentTick`. So, after tick 5 is done, `logicGroup.lastTick` becomes 5.
 *
 * 7.  **Preventing Double Reactions**: On the next tick (tick 6), the system will not re-process the same change from
 *     tick 5, because the condition `dirtyTick (5) > lastCompletedLogicTick (5)` will be false. This elegant solution
 *     prevents double-reactions while allowing for immediate reactivity between different systems or within the same
 *     system.
 */
export class GameLoop {
	/**
	 * @param {import('./SystemManager.js').SystemManager} systemManager - The system manager instance.
	 */
	constructor() {
		this.lastTick = 0
		this.currentTick = 1
		this.frameCounter = 0

		this.FIXED_TIMESTEP = 1 / 60
		this.MAX_ACCUMULATED_TIME = this.FIXED_TIMESTEP * 5

		this.accumulator = 0.0
		this._animationFrameId = null
		this._lastTime = 0
		this.isPaused = false

		this.app = null
		this.renderer = null

		this.scheduler = null

		// A single, reusable context object to pass to systems.
		// This avoids creating new objects every frame, reducing GC pressure.
		this.frameContext = {
			deltaTime: 0,
			alpha: 0,
			currentTick: 0,
			lastTick: 0,
		}
	}

	async init(engine) {
		const { workerManager, systemManager } = engine.getManagers()
		this.workerManager = workerManager
		this.systemManager = systemManager
		this.app = this.systemManager.app
		this.renderer = this.systemManager.renderer

		// Initialize the scheduler, which will allocate its own shared memory.
		this.scheduler = new Scheduler()
		await this.scheduler.init(engine)

		// Now that the scheduler has allocated the shared buffers, we can fully
		// initialize the workers with all the data they need.
		await this.workerManager.initializeWorkers(engine)
	}

	/**
	 * Starts the main game loop.
	 * This loop manages a fixed timestep for gameplay logic and variable updates for other systems.
	 */
	start() {
		this.app.stop()

		this._lastTime = performance.now()
		this._loop()
	}

	/**
	 * Pauses the game loop. It will complete the current frame if one is in progress,
	 * but will not start a new one.
	 */
	pause() {
		this.isPaused = true
		console.log('[GameLoop] Paused.')
	}

	/**
	 * Resumes the game loop if it was paused.
	 */
	resume() {
		if (!this.isPaused) return
		this.isPaused = false
		console.log('[GameLoop] Resumed.')
		// Reset time to avoid a large deltaTime spike after the pause.
		this._lastTime = performance.now()
		// Request a new animation frame to restart the loop.
		if (!this._animationFrameId) {
			this._loop()
		}
	}

	/**
	 * The core async game loop, driven by requestAnimationFrame.
	 * @private
	 */
	// --- FRAME LIFECYCLE ---
	// The order of operations within this single `_loop` function defines the entire frame lifecycle.
	// Since we have disabled PIXI's internal ticker by calling `app.stop()`, we are in full
	// control of the render pipeline.
	//
	// The sequence is as follows:
	// 1. Calculate `rawDeltaTime`.
	// 2. Run `input` systems (e.g., for low-latency input like the cursor).
	// 3. Run `logic` systems in a loop for deterministic game logic (e.g., physics).
	// 4. Run any other dynamically timed system groups (e.g., for infrequent UI updates).
	// 5. Run `visuals` systems for per-frame logic (e.g., camera, interpolation).
	// 6. Flush the `commandBuffer` to apply all structural ECS changes.
	// 7. **Call `renderer.render()`**. This is the explicit call that tells PixiJS to draw the scene.
	// 8. Request the next animation frame.
	// The loop is defined as an arrow function class field to automatically bind `this`.
	// This avoids the need for `.bind(this)` in the constructor or creating a new
	// function on every frame for `requestAnimationFrame`, which is a performance anti-pattern.
	_loop = async () => {
		if (!this.systemManager) return // Loop has been destroyed
		if (this.isPaused) {
			// If paused, ensure any scheduled frame is cancelled.
			if (this._animationFrameId) {
				cancelAnimationFrame(this._animationFrameId)
				this._animationFrameId = null
			}
			return
		}

		const currentTime = performance.now()
		const rawDeltaTime = (currentTime - this._lastTime) / 1000.0
		this._lastTime = currentTime

		this.frameCounter++
		// --- 1. Input Phase (Variable Timestep) ---
		// Runs once per frame for low-latency input processing.
		const inputSystems = this.systemManager.updateGroups.input.systems

		if (inputSystems.length > 0) {
			this.frameContext.deltaTime = rawDeltaTime
			this.frameContext.currentTick = this.currentTick
			this.frameContext.lastTick = this.systemManager.updateGroups.input.lastTick
			this.frameContext.alpha = 0 // Not applicable, but set for consistency
			await this.scheduler.execute(inputSystems, this.frameContext, this.frameCounter)
		}

		// --- 2. Logic Phase (Fixed Timestep) ---
		// This loop ensures deterministic updates for gameplay and physics.
		this.accumulator += Math.min(rawDeltaTime, this.MAX_ACCUMULATED_TIME)

		// It's important to update the group's lastTick *after* its execution for a given tick.
		// We capture the last tick value *before* the loop, as this is what reactive systems
		// in this group will compare against.
		const lastLogicTickForGroup = this.systemManager.updateGroups.logic.lastTick

		const logicSystems = this.systemManager.updateGroups.logic.systems

		while (this.accumulator >= this.FIXED_TIMESTEP) {
			if (logicSystems.length > 0) {
				this.frameContext.deltaTime = this.FIXED_TIMESTEP
				this.frameContext.currentTick = this.currentTick
				this.frameContext.lastTick = lastLogicTickForGroup
				this.frameContext.alpha = 0 // Not applicable
				await this.scheduler.execute(logicSystems, this.frameContext, this.frameCounter)
			}

			// After logic systems run for a tick, we update the group's last tick and advance the global tick.
			this.lastTick = this.currentTick
			this.systemManager.updateGroups.logic.lastTick = this.currentTick
			this.currentTick++
			this.accumulator -= this.FIXED_TIMESTEP
		}

		// --- 3. Timed Systems Phase (Variable Timestep) ---
		// This handles any custom-timed groups (e.g., 10 FPS UI updates).
		for (const groupName in this.systemManager.updateGroups) {
			if (groupName === 'input' || groupName === 'logic' || groupName === 'visuals') {
				continue // Skip the main groups, which are handled separately.
			}

			const group = this.systemManager.updateGroups[groupName]
			group.accumulator += rawDeltaTime

			if (group.accumulator >= group.interval) {
				this.frameContext.deltaTime = group.accumulator // Pass the actual elapsed time
				this.frameContext.currentTick = this.currentTick
				this.frameContext.lastTick = group.lastTick
				this.frameContext.alpha = 0 // Not applicable
				await this.scheduler.execute(group.systems, this.frameContext, this.frameCounter)
				group.accumulator = 0 // Reset accumulator for this group
			}
		}

		// --- 4. Visuals Phase (Variable Timestep with Interpolation) ---
		// Runs once per frame for rendering, camera, and UI.
		const visualsSystems = this.systemManager.updateGroups.visuals.systems

		if (visualsSystems.length > 0) {
			const alpha = this.accumulator / this.FIXED_TIMESTEP
			this.frameContext.deltaTime = rawDeltaTime
			this.frameContext.alpha = alpha
			this.frameContext.currentTick = this.currentTick
			this.frameContext.lastTick = this.systemManager.updateGroups.visuals.lastTick

			// Await the completion of all jobs for this group.
			await this.scheduler.execute(visualsSystems, this.frameContext, this.frameCounter)
		}

		// --- 5. Post-Execution Frame Finalization ---

		// --- Command Buffer Flush ---
		// This must happen after all system groups are complete.
		const cbFlushStartTime = performance.now()
		this.systemManager.commandBufferExecutor.execute(this.systemManager.commandBuffer, this.currentTick)

		// Sync the last-run tick for all non-logic groups to the last completed logic tick of this frame.
		// This ensures reactivity is consistent across all of them for the next frame.
		for (const groupName in this.systemManager.updateGroups) {
			if (groupName !== 'logic') {
				const group = this.systemManager.updateGroups[groupName]
				group.lastTick = this.lastTick
			}
		}

		const cbFlushEndTime = performance.now()

		// --- Performance Data Recording ---
		this.systemManager.recordSystemTiming('Command Buffer', 'total', cbFlushEndTime - cbFlushStartTime)

		// The PerformanceMonitor's own `update` job has run. Now we call its special methods
		// to collect the complete timing data for the frame and update its display.
		const perfMon = systemRegistry.getSystem('PerformanceMonitor')

		if (perfMon) {
			perfMon.updateTimings(rawDeltaTime)
			perfMon.updateDisplay(rawDeltaTime)
		}

		this.systemManager.clearSystemTimings()

		// Broadcast all structural deltas (chunks, archetype pages) to workers.
		this.workerManager.broadcastDeltas()

		// --- Maintenance Phase ---
		await this.scheduler.executeMaintenance(this.currentTick, this.frameContext)

		// --- Manual Render Call ---
		const renderStartTime = performance.now()

		this.renderer.render(this.app.stage)
		const renderEndTime = performance.now()
		this.systemManager.recordSystemTiming('Render', 'total', renderEndTime - renderStartTime)

		// --- Advance Tick ---
		// The main logic tick is advanced inside the fixed logic loop. This section
		// is for other bookkeeping.

		// --- 6. Request Next Frame ---
		this._animationFrameId = requestAnimationFrame(this._loop)
	}

	/**
	 * Destroys the game loop and cleans up resources.
	 */
	destroy() {
		if (this._animationFrameId) {
			cancelAnimationFrame(this._animationFrameId)
			this._animationFrameId = null
		}
		this.app = null
		this.renderer = null
		this.systemManager = null
	}
}
