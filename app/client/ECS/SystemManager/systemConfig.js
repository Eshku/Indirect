/**
 * Centralized configuration for game systems.
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
 *   that don't need a per-frame update.
 *
 * - **`'input'`**: Runs once per frame, before the main logic. Designed for low-latency systems that
 *   process raw user input before any gameplay calculations occur.
 *
 * - **`'logic'`**: Runs on a fixed, deterministic timestep (e.g., 60 times per second). This is for all
 *   core gameplay logic, such as physics, state changes, and AI.
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

	Cursor: [{ name: 'CursorSystem', frequency: 'input' }],

	Input: [{ name: 'PlayerInputSystem', frequency: 'input' }],

	// Runs on a fixed timestep for deterministic gameplay logic and physics.
	Logic: [
		{ name: 'CooldownSystem', frequency: 'logic' },

		{ name: 'MovementSystem', frequency: 'logic' },

		{ name: `ApplyVelocity`, frequency: `logic` },

		{ name: 'SpatialHashingSystem', frequency: 'logic' },

		{ name: 'EventEntityCleanupSystem', frequency: 'logic' },
	],

	// Infrequent UI updates. Runs on a timer, not every frame.
	Timed: [],

	// Runs once per rendered frame for smooth visuals, interpolation, and UI.
	Visuals: [
		{ name: 'SpriteFactorySystem', frequency: 'visuals' },
		{ name: 'RenderLayerSystem', frequency: 'visuals' },
		{ name: 'TooltipSystem', frequency: 'visuals' },
		{ name: 'CameraSystem', frequency: 'visuals' },
		{ name: 'SyncTransforms', frequency: 'visuals' },
	],

	Debug: [
		{ name: 'PerformanceMonitor', frequency: 'visuals' },
		{ name: 'FpsCounter', frequency: 'visuals' },
		//{ name: 'SpatialHashDebugSystem', frequency: 'visuals' },
	],

	//! Do not run benchmark \ test systems with other systems together, high query overlap potential.

	Benchmark: [
		/* { name: 'CPUBenchmark', frequency: 'logic' }, */
		/* { name: 'ParallelCPUBenchmark', frequency: 'logic' }, */ 

		/* { name: 'RWMBenchmark', frequency: 'logic' },  */
		
		/* { name: 'CommandBufferBenchmarkSystem', frequency: 'visuals' }, */
	],

	Test: [
		/* { name: 'DataIntegrityTestSystem', frequency: 'logic' }, */
		/* { name: 'ParallelismTestSystem', frequency: 'logic' }, */
		/* { name: 'ContextTestSystem', frequency: 'logic' }, */
		/* { name: 'CustomJobTestSystem', frequency: 'logic' }, */
		/* 		{ name: 'DependencySystemA', frequency: 'visuals' },
		{ name: 'DependencySystemB', frequency: 'visuals' },
		{ name: 'DependencySystemC', frequency: 'visuals' }, */
		/* { name: 'KernelArchitecture', frequency: 'logic' }, */
	],

	CoreTests: [
		/* { name: 'PayloadCompilerTestSystem', frequency: 'none' }, */
		/* { name: 'CommandBufferTestSystem', frequency: 'none' }, */
		/* { name: 'SchemaTestSystem', frequency: 'none' }, */
		/* { name: 'GenerationalEntityTestSystem', frequency: 'none' }, */
	],

	TickTests: [
		/* { name: 'ReactivityTestSystem', frequency: 'logic' }, */
		/* { name: 'TimedSystemTest', frequency: 1 }, */
	],
}
