import { systemRegistry } from './SystemRegistry.js'
import { Scheduler } from './Scheduler.js'
import { executionContext } from '@core/ExecutionContext.js'

/**
 * Manages the core game loop, including fixed and variable timesteps.
 */

/**
 * --- ARCHITECTURAL NOTE on the Async Game Loop ---
 *
 * ### 1. The Purpose of `async`: Non-Blocking Parallelism
 *
 * The primary reason the loop is `async` is to allow the main thread to efficiently
 * wait for worker threads to complete their jobs without freezing the application.
 * This is achieved using `await Atomics.waitAsync(...)`.
 *
 * - **`waitAsync` vs. `wait`**: It is critical to use `Atomics.waitAsync`. The
 *   synchronous version, `Atomics.wait()`, would **block the main thread**
 *   and freeze the entire application, including rendering and user input. `waitAsync`,
 *   however, only pauses the execution of the `_loop` function. It yields control
 *   back to the browser's event loop, keeping the application responsive while
 *   waiting for background work.
 *
 * This allows the main thread to participate in the work-stealing scheduler, executing
 * its own jobs and then sleeping efficiently until more work is available, all without
 * blocking the browser's rendering pipeline.
 *
 * ### 2. Synchronous Systems
 *
 * All system lifecycle methods (`update`, `process`) and parallel `kernel` functions
 * are **synchronous**. The scheduler does not `await` them. This design enforces
 * that the core logic running on the job system is fast, CPU-bound work, which
 * prevents a single long-running operation from stalling a worker thread or the main loop.
 *
 * /

/**
 * --- ARCHITECTURAL NOTE on Reactivity and Ticks ---
 *
 * The engine's reactivity system is based on a simple principle:
 * a system should only react to component changes that have occurred *since the last time that system ran*.
 * This is managed through a per-group `lastTick` property and a global `currentTick`.
 * The implementation uses a "next-tick" model for reactivity.
 *
 * The process for a given system group (e.g., 'logic') within a single game loop iteration works as follows:
 *
 * 1.  **Get Last Completed Tick**: Before executing the systems in a group for `currentTick = N`, we retrieve the group's `lastTick` value.
 *     This value represents the game tick number during which the group last completed its execution (e.g., `N-1`).
 *
 * 2.  **Execute Systems**: Systems in the group run. They queue commands (e.g., `setComponent`) in the `entityCommandBuffer`.
 *
 * 3.  **Flush Commands**: After all systems in the group have finished, the `GameLoop` flushes the command buffer.
 *     Crucially, it flushes with the *next* tick's ID: `flush(currentTick + 1)`. So, changes made during tick `N` are timestamped as belonging to tick `N+1`.
 *
 * 4.  **Update Group's Last Tick**: After the flush, the group's `lastTick` is updated to `this.currentTick`. So, after tick `N` is done, `logicGroup.lastTick` becomes `N`.
 *
 * 5.  **Advance Global Tick**: The global `currentTick` is incremented to `N+1`.
 *
 * 6.  **Reactivity Check (Next Frame)**: On the next frame, the group runs for `currentTick = N+1`. Its `lastTick` is `N`.
 *     A reactive query inside a system checks for changes in the range `(lastTick, currentTick]`, which is `(N, N+1]`.
 *     The change from the previous frame, which was timestamped with `N+1`, is found because `dirtyTick (N+1) > lastTick (N)` is true.
 *
 * 7.  **Preventing Double Reactions**: On the next tick (tick 6), the system will not re-process the same change from
 *     tick 5, because the condition `dirtyTick (5) > lastCompletedLogicTick (5)` will be false.
 *
 * This "next-tick" model ensures that all structural changes from a given tick are fully resolved before any system attempts to react to them, preventing race conditions and ensuring a stable world state for reactive systems.
 */
export class GameLoop {
	
	/**
	 * @param {import('./SystemManager.js').SystemManager} systemManager - The system manager instance.
	 */
	constructor() {
		// The global version counter. It's incremented before each group execution.
		this.globalVersion = 0
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
	}

	async init(engine) {
		const { workerManager, systemManager, entityMaskManager, eventManager } = engine.getManagers()
		this.workerManager = workerManager
		this.systemManager = systemManager
		this.entityMaskManager = entityMaskManager
		this.eventManager = eventManager
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
	// 6. Flush `entityCommandBuffer` to apply all structural ECS changes.
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
			this.globalVersion++
			const groupRunVersion = this.globalVersion
			const lastVersion = this.systemManager.updateGroups.input.lastProcessedVersion
			const frameContext = {
				deltaTime: rawDeltaTime,
				alpha: 0, // Not applicable, but set for consistency
				currentVersion: groupRunVersion,
				lastVersion: lastVersion,
				frameCounter: this.frameCounter,
			}
			executionContext.update(frameContext)
			await this.scheduler.execute(inputSystems, frameContext, this.frameCounter)
			this.systemManager.updateGroups.input.lastProcessedVersion = groupRunVersion
		}

		// --- 3. Logic Phase (Fixed Timestep) ---
		// This loop ensures deterministic updates for gameplay and physics.
		this.accumulator += Math.min(rawDeltaTime, this.MAX_ACCUMULATED_TIME)

		// It's important to update the group's lastTick *after* its execution for a given tick.
		// We capture the last tick value *before* the loop, as this is what reactive systems
		// in this group will compare against.
		let lastLogicVersionForGroup = this.systemManager.updateGroups.logic.lastProcessedVersion

		const logicSystems = this.systemManager.updateGroups.logic.systems

		while (this.accumulator >= this.FIXED_TIMESTEP) {
			if (logicSystems.length > 0) {
				this.globalVersion++
				const groupRunVersion = this.globalVersion
				const frameContext = {
					deltaTime: this.FIXED_TIMESTEP,
					alpha: 0, // Not applicable
					currentVersion: groupRunVersion,
					lastVersion: lastLogicVersionForGroup,
					frameCounter: this.frameCounter,
				}
				executionContext.update(frameContext)
				await this.scheduler.execute(logicSystems, frameContext, this.frameCounter)
				lastLogicVersionForGroup = groupRunVersion
			}

			// --- Flush after each logic step ---
			// This is the primary synchronization point for the ECS. It ensures that structural changes
			// made during a version are applied and visible to all systems running in the next version. This is crucial for reactive systems and for maintaining
			// a consistent world state, especially when multiple logic ticks are processed in a single
			// frame during lag catch-up.
			this._flushCommandBuffer()

			// After logic systems run for a tick, we update the group's last tick and advance the global tick.
			this.systemManager.updateGroups.logic.lastProcessedVersion = lastLogicVersionForGroup
			this.accumulator -= this.FIXED_TIMESTEP
		}

		// --- 2. Timed Systems Phase (Variable Timestep) ---
		// This handles any custom-timed groups (e.g., 10 FPS UI updates).
		// We run this AFTER the logic loop so that timed systems can react to the latest
		// state changes from the logic group.
		for (const groupName in this.systemManager.updateGroups) {
			if (groupName === 'input' || groupName === 'logic' || groupName === 'visuals') {
				continue // Skip the main groups, which are handled separately.
			}

			const group = this.systemManager.updateGroups[groupName]
			group.accumulator += rawDeltaTime

			if (group.accumulator >= group.interval) {
				this.globalVersion++
				const groupRunVersion = this.globalVersion
				const frameContext = {
					deltaTime: group.accumulator, // Pass the actual elapsed time
					alpha: 0, // Not applicable
					currentVersion: groupRunVersion,
					lastVersion: group.lastProcessedVersion,
					frameCounter: this.frameCounter,
				}
				executionContext.update(frameContext)
				await this.scheduler.execute(group.systems, frameContext, this.frameCounter)
				group.lastProcessedVersion = groupRunVersion
				group.accumulator = 0 // Reset accumulator for this group
			}
		}

		// --- Pre-Visuals Sync Point ---
		// This is a critical synchronization point. We flush the command buffer here to ensure
		// that any structural changes from the 'input', 'logic', or 'timed' groups
		// are fully applied and visible to the 'visuals' group in the same frame.
		// Note: The logic loop has its own internal flush for each tick. This flush
		// handles commands queued by input/timed systems, or by logic systems if the
		// logic loop didn't run this frame.
		this._flushCommandBuffer()

		// --- 4. Visuals Phase (Variable Timestep with Interpolation) ---
		const visualsSystems = this.systemManager.updateGroups.visuals.systems

		// The visuals group runs every frame to ensure smooth rendering and interpolation,
		// regardless of whether a logic tick occurred. Visual systems must be robust
		// enough to handle entities that may not be fully initialized (e.g., sprite not yet created).
		if (visualsSystems.length > 0) {
			this.globalVersion++
			const groupRunVersion = this.globalVersion
			const alpha = this.accumulator / this.FIXED_TIMESTEP
			const frameContext = {
				deltaTime: rawDeltaTime,
				alpha: alpha,
				currentVersion: groupRunVersion,
				lastVersion: this.systemManager.updateGroups.visuals.lastProcessedVersion,
				frameCounter: this.frameCounter,
			}
			executionContext.update(frameContext)
			await this.scheduler.execute(visualsSystems, frameContext, this.frameCounter)
			this.systemManager.updateGroups.visuals.lastProcessedVersion = groupRunVersion
		}

		// --- Manual Render Call ---
		const renderStartTime = performance.now()
		this.renderer.render(this.app.stage)
		const renderEndTime = performance.now()
		this.systemManager.recordSystemTiming('Render', 'total', renderEndTime - renderStartTime)

		// --- 5. Post-Execution Frame Finalization ---

		// The PerformanceMonitor's own `update` job has run. Now we call its special methods
		// to collect the complete timing data for the frame and update its display.
		const perfMon = systemRegistry.getSystem('PerformanceMonitor')

		if (perfMon) {
			perfMon.updateTimings(rawDeltaTime)
			perfMon.updateDisplay(rawDeltaTime)
		}

		this.systemManager.clearSystemTimings()

		// --- Advance Tick ---
		// The main logic tick is advanced inside the fixed logic loop. This section
		// is for other bookkeeping.

		// --- 6. Request Next Frame ---
		this._animationFrameId = requestAnimationFrame(this._loop)
	}

	_flushCommandBuffer() {
		// A command buffer flush is an atomic event that advances the world state.
		// We increment the global version *before* flushing to get a new, unique version for these changes.
		this.globalVersion++
		const flushVersion = this.globalVersion
		const cbStartTime = performance.now()

		this.systemManager.commandBufferExecutor.flush(this.systemManager.entityCommandBuffer, flushVersion)
		const cbEndTime = performance.now()
		// Immediately after flushing, broadcast the structural changes to workers.
		// This ensures workers have the latest world state before any new jobs are scheduled.
		this.workerManager.broadcastDeltas()
		this.systemManager.recordSystemTiming('Entity Command Buffer', 'total', cbEndTime - cbStartTime)
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
