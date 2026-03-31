/**
 * Centralized configuration for game systems.
 * This module defines which systems are active and their update frequencies.
 */

/**
 *
 * ### System Activation
 * Any system listed in this file will be loaded, instantiated, and initialized by `SystemManager`.
 * Systems not listed here will not run.
 *
 * ### Initialization and Execution Order
 *
 * **1. Initialization Order (init())**
 *    The order of systems in this file **explicitly defines the `init()` order**. Systems are instantiated
 *    and initialized sequentially as they appear below. This is critical for systems that have `init()`-time
 *    dependencies on others.
 *
 * **2. Execution Order (update())**
 *    The order here defines the **base order** for the `Scheduler`'s dependency analysis. The final execution
 *    order is determined by three factors in this priority:
 *
 *    - **Highest Priority: `runsAfter`**. An explicit `runsAfter: [OtherSystem]` in a system's class is a hard rule that the `Scheduler` must follow.
 *    - **Medium Priority: Data Dependencies (`reads`/`writes`)**. The `Scheduler` analyzes the base order from this file. If `SystemA` is listed before `SystemB`, and `B` reads a component that `A` writes, a dependency `A -> B` is automatically created.
 *    - **Lowest Priority: This File's Order**. If there are no other dependencies, systems will tend to run in the order they are listed here.
 *
 *
 * ### Update Frequencies
 * `Frequency` property determines how often a system's `update` method is called:
 *
 * - **`'none'`**: For systems that only need to be initialized. Their constructor and `init()` method are
 *   called, but they are not added to any update loop. Ideal for purely event-driven systems
 *   that don't need a per-frame update.
 *
 * - **`'input'`**: Runs once per frame, before main logic. Designed for low-latency systems that
 *   process raw user input before any gameplay calculations occur.
 *
 * - **`'logic'`**: Runs on a fixed, deterministic timestep (e.g., 60 times per second). This is for all
 *   core gameplay logic, such as physics, state changes, and AI.
 *
 * - **`'visuals'`**: Runs once per rendered frame (variable timestep). These systems receive an `alpha`
 *   interpolation value, making them perfect for tasks that need to be visually smooth, like camera
 *   movement, animations, and UI updates that must sync with rendering.
 *
 * - **`number` (e.g., `10`)**: Runs on a timer at specified updates-per-second. These are for
 *   infrequent tasks that don't need to run every frame, like periodic UI refreshes.
 */
export const systemSchedule = {
	Initialization: [
		{ name: 'UIInputSystem', frequency: 'none' },
		{ name: 'BackgroundSystem', frequency: 'none' },
	],

	Cursor: [{ name: 'CursorSystem', frequency: 'input' }],

	Input: [{ name: 'PlayerInputSystem', frequency: 'input' }],

	// Runs on a fixed timestep for deterministic gameplay logic and physics.
	Logic: [
		// This system ticks down the timer on active hit flash effects.
		// It's separate from the visual system for clarity.
		{ name: 'HitFlashTimerSystem', frequency: 'logic' },
		// Ticks down the timer for active immunity effects.
		{ name: 'ImmunityTimerSystem', frequency: 'logic' },
		{ name: 'CooldownSystem', frequency: 'logic' },

		{ name: 'EnemyAISystem', frequency: 'logic' },

		{ name: 'PlayerWeaponSystem', frequency: 'logic' },

		{ name: 'ProjectileLifetimeSystem', frequency: 'logic' },

		{ name: 'MovementSystem', frequency: 'logic' },

		{ name: 'SpatialHashingSystem', frequency: 'logic' },

		{ name: 'CollisionDetectionSystem', frequency: 'logic' },

		{ name: `ApplyVelocity`, frequency: `logic` },

		{ name: 'DamageSystem', frequency: 'logic' },

		{ name: 'HealthSystem', frequency: 'logic' },

		{ name: 'PoolingSystem', frequency: 'logic' },

		{ name: 'EventEntityCleanupSystem', frequency: 'logic' },
	],

	// Infrequent UI updates. Runs on a timer, not every frame.
	Timed: [
		{ name: 'SpawnDirectorSystem', frequency: 2 },
		{ name: 'OffscreenCleanupSystem', frequency: 1 },
	], // Runs once per rendered frame for smooth visuals, interpolation, and UI.
	Visuals: [
		{ name: 'SpriteFactorySystem', frequency: 'visuals' },

		// This system places the newly created visual objects onto their correct rendering layers.
		{ name: 'RenderLayerSystem', frequency: 'visuals' },

		// This system hides/shows sprites based on their lifecycle state (active, dying, pooled).
		{ name: 'HitFlashSystem', frequency: 'visuals' },

		{ name: 'LifecycleVisualSystem', frequency: 'visuals' },

		{ name: 'ImmunityVisualSystem', frequency: 'visuals' },

		{ name: 'SyncTransforms', frequency: 'visuals' },

		{ name: 'SpinningSystem', frequency: 'visuals' },

		{ name: 'CameraSystem', frequency: 'visuals' },
	],

	Debug: [
		{ name: 'PerformanceMonitor', frequency: 'visuals' },
		{ name: 'FpsCounter', frequency: 'visuals' },
		/* { name: 'DebugInspectionSystem', frequency: 'input' }, */
		//{ name: 'SpatialHashDebugSystem', frequency: 'visuals' },
	],

	//! Do not run benchmark \ test systems with other systems together, high query overlap potential.

	Benchmark: [
		/* { name: 'CPUBenchmark', frequency: 'visuals' }, */
		/* { name: 'ParallelCPUBenchmark', frequency: 'logic' }, */
		/* { name: 'RWMBenchmark', frequency: 'visuals' },  */
		/* { name: 'MemoryBenchmark', frequency: 'visuals' }, */
		/* { name: 'CommandBufferBenchmarkSystem', frequency: 'visuals' }, */
	],

	Test: [
		{ name: 'QueryApiTestSystem', frequency: 'logic' },
		/* { name: 'DataIntegrityTestSystem', frequency: 'logic' }, */
		/* { name: 'ParallelismTestSystem', frequency: 'logic' }, */
		/* { name: 'ContextTestSystem', frequency: 'logic' }, */
		/* { name: 'CustomJobTestSystem', frequency: 'logic' }, */
		/* { name: 'KernelArchitecture', frequency: 'logic' }, */
		/* 				{ name: 'DependencySystemA', frequency: 'visuals' },
		{ name: 'DependencySystemB', frequency: 'visuals' },
		{ name: 'DependencySystemC', frequency: 'visuals' }, */
		/* { name: 'BitmaskTestSystem', frequency: 'none' }, */
	],

	CoreTests: [
		/* { name: 'SchemaTestSystem', frequency: 'none' }, */
		/* { name: 'PayloadCompilerTestSystem', frequency: 'none' }, */
		/* { name: 'CommandBufferTestSystem', frequency: 'none' }, */
		/* { name: 'QueryTestSystem', frequency: 'none' }, */
		/* { name: 'SharedArchetypeHashMapTestSystem', frequency: 'none' }, */
		/* { name: 'GenerationalEntityTestSystem', frequency: 'none' }, */
	],

	TickTests: [
		/* { name: 'ReactivityTestSystem', frequency: 'logic' }, */
		/* { name: 'TimedSystemTest', frequency: 1 }, */
	],
}
