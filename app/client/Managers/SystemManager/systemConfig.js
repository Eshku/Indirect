/**
 * @fileoverview Centralized configuration for game systems.
 * This module defines the execution order and update frequencies for all systems in a unified structure.
 */

/**
 * --- DEVELOPER NOTE on System Scheduling & Frequencies ---
 *
 * This object is the single source of truth for system scheduling. It defines the global execution order
 * and assigns each system to an update group based on its `frequency`.
 *
 * ### Execution Order
 * The order of systems within this file defines the global, flattened execution order. This is crucial
 * for resolving dependencies and ensuring correct data flow between systems. For example, `MovementSystem`
 * runs before `CollisionSystem` to ensure collisions are checked against the new, updated positions.
 *
 * ### Update Frequencies
 * The `frequency` property determines how often a system's `update` method is called:
 *
 * - **`'none'`**: For systems that only need to be initialized. Their constructor and `init()` method are
 *   called, but they are not added to any update loop. Ideal for purely event-driven systems
 *   (e.g., setting up listeners for external libraries) that don't need a per-frame update.
 *
 * - **`'input'`**: Runs once per frame, before the main logic. Designed for low-latency systems that
 *   process raw user input before any gameplay calculations occur.
 *
 * - **`'logic'`**: Runs on a fixed, deterministic timestep (e.g., 60 times per second). This is for all
 *   core gameplay logic, such as physics, state changes, and AI. This entire group is a candidate for
 *   future parallel execution on a Web Worker to improve performance.
 *
 * - **`'visuals'`**: Runs once per rendered frame (variable timestep). These systems receive an `alpha`
 *   interpolation value, making them perfect for tasks that need to be visually smooth, like camera
 *   movement, animations, and UI updates that must sync with rendering.
 *
 * - **`number` (e.g., `10`)**: Runs on a timer at the specified updates-per-second. These are for
 *   infrequent tasks that don't need to run every frame, like periodic UI refreshes.
 */
export const systemSchedule = {
	// Systems that only need to be initialized (e.g., for event listeners)
	Initialization: [{ name: 'UIInputSystem', frequency: 'none' }],

	// Runs every frame for lowest-latency input processing.
	Input: [
		{ name: 'CursorSystem', frequency: 'input' },
		{ name: 'InputContextSystem', frequency: 'input' },
		{ name: 'PlayerInputSystem', frequency: 'input' },
	],

	// Runs on a fixed timestep for deterministic gameplay logic and physics.
	Logic: [
		{ name: 'ItemEventSystem', frequency: 'logic' },
		{ name: 'CooldownSystem', frequency: 'logic' },
		{ name: 'JumpSystem', frequency: 'logic' },
		{ name: 'GravitySystem', frequency: 'logic' },
		{ name: 'MovementSystem', frequency: 'logic' },

		{ name: `ApplyVelocity`, frequency: `logic` },
		{ name: 'CollisionSystem', frequency: 'logic' },
		{ name: 'EventEntityCleanupSystem', frequency: 'logic' },
	],

	// Infrequent UI updates. Runs on a timer, not every frame.
	Timed: [],

	// Runs once per rendered frame for smooth visuals, interpolation, and UI.
	Visuals: [
		{ name: 'SpriteFactorySystem', frequency: 'visuals' },
		{ name: 'PlatformFactorySystem', frequency: 'visuals' },

		{ name: 'HotbarSyncSystem', frequency: 'visuals' },
		{ name: 'TooltipSystem', frequency: 'visuals' },

		{ name: 'CameraSystem', frequency: 'visuals' },

		{ name: 'SyncTransforms', frequency: 'visuals' },
	],

	Debug: [
		{ name: 'PerformanceMonitor', frequency: 'visuals' },
		{ name: 'FpsCounter', frequency: 'visuals' },
	],

	// Development and stress-testing.

	Benchmark: [
		/* { name: 'RWMBenchmark', frequency: 'logic' }, */
		/* { name: 'StructuralChangeBenchmarkSystem', frequency: 'logic' }, */
		/* { name: 'BatchStructuralChangeBenchmarkSystem', frequency: 'logic' }, */
		/* { name: 'CreationDestructionBenchmarkSystem', frequency: 'logic' }, */
		/* { name: 'BatchCreationDestructionBenchmarkSystem', frequency: 'logic' }, */
		/* { name: 'QueryBasedDestructionBenchmarkSystem', frequency: 'logic' }, */
		/* { name: 'RenderBenchmarkSystem', frequency: 'logic' }, */
		/* { name: 'ReactivityTestSystem', frequency: 'logic' }, */
	],
}
