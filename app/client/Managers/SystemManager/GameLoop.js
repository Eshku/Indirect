/**
 * @fileoverview Manages the core game loop, including fixed and variable timesteps.
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
 *     reactivity (e.g., `ItemEventSystem` reacting to `PlayerInputSystem`).
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
	constructor(systemManager) {
		this.systemManager = systemManager

		this.lastTick = -1
		this.currentTick = 0

		this.FIXED_TIMESTEP = 1 / 60
		this.MAX_ACCUMULATED_TIME = this.FIXED_TIMESTEP * 5

		this.accumulator = 0.0
		this._animationFrameId = null
		this._lastTime = 0

		this.app = null
		this.renderer = null
	}

	/**
	 * Initializes the game loop with the PIXI application instance.
	 */
	init() {
		this.app = this.systemManager.app
		this.renderer = this.systemManager.renderer

		// We no longer hook into PIXI's runners. We drive the loop ourselves.
	}

	/**
	 * Starts the main game loop.
	 * This loop manages a fixed timestep for gameplay logic and variable updates for other systems.
	 */
	start() {
		// Stop PIXI's default ticker behavior. Our custom `_loop` function, driven by
		// `requestAnimationFrame`, will now control all updates and rendering.
		this.app.stop()

		this._lastTime = performance.now()
		this._loop()
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

		const currentTime = performance.now()
		const rawDeltaTime = (currentTime - this._lastTime) / 1000.0
		this._lastTime = currentTime

		// --- Input Systems ---
		// Manually execute the input group first for low-latency input processing.
		const inputGroup = this.systemManager.updateGroups.input
		if (inputGroup.systems.length > 0) {
			const lastCompletedTick = inputGroup.lastTick
			await this._executeSystemGroup(inputGroup, rawDeltaTime, lastCompletedTick)
			inputGroup.lastTick = this.lastTick
		}

		// --- Logic Systems (Fixed Timestep Loop) ---
		this.accumulator += rawDeltaTime
		// Prevent a "spiral of death" if the game lags badly by capping accumulated time.
		if (this.accumulator > this.MAX_ACCUMULATED_TIME) {
			this.accumulator = this.MAX_ACCUMULATED_TIME
		}

		const logicGroup = this.systemManager.updateGroups.logic

		while (this.accumulator >= this.FIXED_TIMESTEP) {
			// Read the last completed tick *inside* the loop.
			// This ensures that if the loop runs multiple times in one frame (due to lag),
			// each iteration uses the correct, updated value from the previous one,
			// preventing reactive systems from firing multiple times on the same change.
			const lastCompletedLogicTick = logicGroup.lastTick

			this.lastTick = this.currentTick
			await this._executeSystemGroup(logicGroup, this.FIXED_TIMESTEP, lastCompletedLogicTick)

			// Set the group's last tick to the *upcoming* tick.
			// This ensures that on the *next* frame, the reactivity check `dirtyTick > lastRanAt`
			// correctly evaluates to false for changes that have already been processed,
			// preventing a double-trigger on the subsequent frame.
			logicGroup.lastTick = this.currentTick

			// Process input for the upcoming tick & advance the tick counter
			await this._executeSystemGroup(inputGroup, this.FIXED_TIMESTEP, inputGroup.lastTick)
			inputGroup.lastTick = this.currentTick

			this.accumulator -= this.FIXED_TIMESTEP
			this.currentTick++
		}

		// The last tick that any non-fixed-update system should care about is the
		// one that the fixed update loop just finished processing.
		const lastCompletedFixedTick = this.lastTick

		// --- Dynamically Timed Update Loops (for UI, infrequent logic) ---
		for (const group of Object.values(this.systemManager.updateGroups)) {
			if (group.interval) {
				await this._executeTimedGroup(group, rawDeltaTime, lastCompletedFixedTick)
			}
		}

		// --- Visuals Systems (Variable Timestep Loop) ---
		const alpha = this.accumulator / this.FIXED_TIMESTEP
		const visualsGroup = this.systemManager.updateGroups.visuals

		await this._executeSystemGroup(visualsGroup, rawDeltaTime, visualsGroup.lastTick, alpha)
		visualsGroup.lastTick = lastCompletedFixedTick

		// --- Command Buffer Flush ---
		const cbFlushStartTime = performance.now();
		this.systemManager.commandBufferExecutor.execute(this.systemManager.commandBuffer);
		const cbFlushEndTime = performance.now();
		//this.systemManager.systemTimings['CommandBufferExecutor.execute'] = cbFlushEndTime - cbFlushStartTime;

		//! just for performance monitor display for now, change it later
				this.systemManager.systemTimings['CommandBuffer.flush'] = cbFlushEndTime - cbFlushStartTime

		// --- Manual Render Call ---
		const renderStartTime = performance.now()
		this.renderer.render(this.app.stage)
		const renderEndTime = performance.now()
		this.systemManager.systemTimings['Renderer.render'] = renderEndTime - renderStartTime

		// --- Request Next Frame ---
		this._animationFrameId = requestAnimationFrame(this._loop)
	}

	/**
	 * Executes all systems within a given group.
	 * @param {object} group - The update group to execute.
	 * @param {number} deltaTime - The time elapsed since the last update for this group.
	 * @param {number} lastTick - The last tick processed by this group, for change detection.
	 * @param {number} [alpha=0] - The interpolation factor for rendering between fixed updates.
	 * @private
	 */
	async _executeSystemGroup(group, deltaTime, lastCompletedTick, alpha = 0) {
		const systems = group.systems
		if (!systems || systems.length === 0) return

		for (const system of systems) {
			const systemName = system.constructor.name
			this.systemManager._primeSystemQueries(system, lastCompletedTick)
			try {
				const startTime = performance.now()
				await system.update(deltaTime, this.currentTick, lastCompletedTick, alpha)
				const endTime = performance.now()
				this.systemManager.systemTimings[systemName] = endTime - startTime
			} catch (error) {
				// Error is already captured with the systemName
				console.error(`GameLoop: Error updating system ${systemName}:`, error)
			}
		}
	}

	/**
	 * Executes a timed group if its update interval has been reached.
	 * @param {object} group - The timed update group to check and potentially execute.
	 * @param {number} rawDeltaTime - The raw delta time from the main ticker.
	 * @param {number} lastCompletedFixedTick - The last tick completed by the main fixed update loop.
	 * @private
	 */
	async _executeTimedGroup(group, rawDeltaTime, lastCompletedFixedTick) {
		if (!group || group.systems.length === 0) return

		group.accumulator += rawDeltaTime
		while (group.accumulator >= group.interval) {
			await this._executeSystemGroup(group, group.interval, group.lastTick)
			group.lastTick = lastCompletedFixedTick
			group.accumulator -= group.interval
		}
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
