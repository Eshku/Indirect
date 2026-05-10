# JavaScript Hybrid ECS Game Engine Thing

## Table of Contents

- [Vision & Principles](#vision--principles)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Key Features](#key-features)
- [Acknowledgements](#acknowledgements)

## Current Stage:

Experimental, constantly changing. Expect breaking changes and bugs.

## Potential future improvements:

- Thread safe everything that could \ should be thread safe.
- Dynamic \ packed arrays.
- Priority Queue
- Serialization/Deserialization
- Allow to redefine default execution order within systems.
- HMR
- Demo and proper documentation
- Pray [proposal-structs](https://github.com/tc39/proposal-structs) is implemented.
- Port core to wasm \ cpp.

## Vision & Principles

Long-term vision is to build a high-performance, **data-oriented**, and **parallel** Entity-Component-System (ECS) in JavaScript.

#### Guiding Principles

1.  **Performance Over "Comfort"**: Design decisions always prioritize raw performance and efficient data access patterns over comfy API.

2.  **Maximum Developer Control**: Provide as many tools and much control to developers as possible.

3.  **Zero-Cost Abstractions (Pay Only For What You Use)**: Actively avoiding adding features to the core engine if they impose runtime performance penalty on _all_ users, regardless of whether they use the feature. New abstractions are only acceptable if they have a negligible or zero-cost runtime cost for those who don't opt into them.

## Tech Stack

- **Electron**: Main application framework.
- **Vanilla JavaScript**: Core language.

## Architecture

- **Entity**: ID representing a game object.
- **Component**: Schema defining data layout for entities, within systems used as ID.
- **Archetype**: All entities with same set of components belong to same archetype.
- **[System](app/client/Systems)**: Class containing game logic that operates on entities.
- **[Kernel](app/client/Kernels)**: Pure function containing logic designed to be run in parallel on worker threads.
- **[Manager](app/client/Managers)**: A class that owns a resource and provides an API to interact with it.

## Key Features

### [Component Schemas](app/client/Components/)

Components are defined as plain JavaScript objects that act as a schema, dictating how data is stored.

- **`playerTag` (Tag Component):**

```javascript
export const playerTag = {}
```

- **`health` (Primitive Types):**

```javascript
export const health = {
	value: { type: 'f32', default: 100 },
	max: { type: 'f32', default: 100 },
}
```

- **`name` (String):**

```javascript
export const name = {
	name: { type: 'string', default: 'No Name' },
}
```

**Schema Types:**

- **Primitives**: `f64`, `f32`, `i32`, `u32`, `i16`, `u16`, `i8`, `u8`, `u64`.
- **`string`**: Interned string data, stored as a `u32` reference.
- **`enum`**: For mutually exclusive states, defined with a key-value object.
- **`bitmask`**: For properties that can have multiple states simultaneously.
- **`flat_array`**: For fixed-size collections of simple data.
- **Tag Components**: An empty schema `{}` that serves only as a marker for queries.

### Queries

Systems use queries to find and iterate over groups of entities that possess a specific set of components.

**Query Types:**

**Basic Queries**:

- **`with`**: Components that must be present.
- **`without`**: Components that must _not_ be present.
- **`any`**: A list of components where at least one must be present.

**Reactive**:

- **`modified`**: Component's data has been modified.
- **`added`**: Component was added.
- **`removed`**:Component has been removed.

**Querying for Entities**

A system has access to helper methods for interacting with chunks, such as `getChunkSize`, `getEntities`, and `getComponentData`.

```javascript
const enemyChunkIds = this.enemyQuery.getChunks()

for (let i = 0; i < enemyChunkIds.length; i++) {
	const chunkId = enemyChunkIds[i]
	// Get typed array access to component data for this chunk.
	const enemyPositions = this.getComponentData(chunkId, position)
	const enemyIntents = this.getComponentData(chunkId, movementIntent)
	const chunkSize = this.getChunkSize(chunkId)

	for (let j = 0; j < chunkSize; j++) {
		// Directly read from and write to component data arrays.
		enemyIntents.desiredX[j] = playerX - enemyPositions.x[j]
		enemyIntents.desiredY[j] = playerY - enemyPositions.y[j]
	}
}
```

For a complete list of available methods, see `Query.js`.

### Parallelism: A Kernel-Based Job Scheduler

Engine uses a hybrid parallel job scheduler that separates main-thread **orchestration** (in a System) from parallel **execution** (in a Kernel).

- **System Class (`.js`):** Lives on main thread. It defines queries and uses a `JobWriter` to schedule jobs for a frame.
- **Kernel Module (`/app/client/Kernels/*.js`):** A plain JavaScript module containing a pure "kernel" function that executes on a worker in parallel.

**System Lifecycle & API:**

System methods are executed in a specific, guaranteed order. An `async init()` method is preferred over a `constructor` for setup logic, as it runs after the System API is injected.

- **`init()`**: (Optional) `async` method for one-time setup. A system has access to its API here.
- **`update(frameContext)`**: (Optional) Runs on **main thread**. For logic that cannot be parallelized.
- **`schedule(jobWriter, frameContext)`**: (Optional) Runs on **main thread** to schedule jobs using the provided `JobWriter` API. This method defines the work to be done.
- **`process(frameContext)`**: (Optional) Runs on **main thread** after all other jobs for this system are complete. It's a finalizer.
- **`destroy()`**: (Optional) `async` method for cleanup.

**Execution Order:**

1.  **Job Creation**: method of all active systems is called on the main thread. It uses a `JobWriter` to populate a shared job buffer. This step only _defines_ the work.
2.  **`update()`**: method of systems runs on the main thread. It is used for any logic that must run sequentially before parallel kernels begin.
3.  **Kernel Execution**: Kernel jobs created during job creation phase are now executed in parallel across worker threads.
4.  **`process()`**: method runs on the main thread after all of a system's `update()` and kernel jobs have finished.

**Declaring Dependencies:**

System declares its data access patterns and dependencies in a `static dependencies` object. The key for each entry must match the kernel function's name.

- **`reads`/`writes`**: An array of component Type IDs. Informs scheduler about data access to prevent race conditions.
- **`context`**: A plain object containing static data passed to a kernel.
- To define execution order _between systems_, a class can declare `static runsAfter = [OtherSystemID]`.

**System & Kernel Example:**

**1. Kernel (`/app/client/Kernels/`)**

Kernel is a function that runs on a worker, receiving all its data via arguments. Frame-specific data is available on `self.frameContext`, and thread-safe helpers are on the global `parallel` object.

```javascript
/**
 * A "kernel" function which runs in parallel on worker threads.
 * @param {number} chunkId - The chunkId to process, passed from the job definition.
 * @param {object} systemContext - Read-only data from system's static dependencies `context` block.
 * @param {object} kernelContext - Thread-local helpers, like getScratchBuffer.
 */
export function heavyCpuWork(chunkId, systemContext, kernelContext) {
	// System-specific static data is passed in.
	const { position, velocity } = systemContext

	// Get direct access to component data arrays for the chunk.
	const positions = self.kernel.getComponentData(chunkId, position)
	const velocities = self.kernel.getComponentData(chunkId, velocity)
	const chunkSize = self.kernel.getChunkSize(chunkId)

	// Iterate over all entities in the chunk.
	for (let i = 0; i < chunkSize; i++) {
		let x = positions.x[i]
		let y = velocities.y[i]

		// do something heavy here
	}
}
```

**2. System (`/app/client/Systems/`)**

The System class orchestrates work from the main thread.

```javascript
const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

// Get numeric IDs for components and kernels at initialization.
const { position, velocity } = ecs.getComponentIDs()
const { heavyCpuWork } = ecs.getKernelIDs()

export class ParallelSystem {
	// Declare all data access and execution dependencies statically.
	static dependencies = {
		// The key 'heavyCpuWork' must match the kernel function name.
		heavyCpuWork: {
			reads: [velocity],
			writes: [position],
			// Pass component IDs to the kernel's `systemContext`.
			context: { position, velocity },
		},
	}

	init() {
		this.query = this.getQuery({ with: [position, velocity] })
	}

	// Runs on the main thread to schedule concurrent jobs for the frame.
	schedule(jobWriter, frameContext) {
		// Runs heavyCpuWork function for every chunk in this.query in parallel.
		jobWriter.scheduleForEachChunk(this.query, heavyCpuWork)
	}
}
```

### System API

All structural changes to entities (creation, deletion, adding/removing components) are deferred using an `EntityCommandBuffer`.

A set of common methods are injected into every system instance. These provide direct access to the command buffer and the payload compiler.

- **`compile()`**: Creates a reusable, low-level binary payload from a high-level source (like a component object or prefab name). This is the "Compile" step.
- **`instantiate()`**: Queues the creation of one or more entities from a compiled payload. This is the "Command" step.
- **`addComponent()` / `addComponents()`**: Queues the addition of one or more components to an entity, using a compiled payload.
- **`setComponent()` / `setComponents()`**: Queues a change to an entity's component data, using a compiled payload.
- **`removeComponent()` / `removeComponents()`**: Queues removal of components.
- **`destroyEntity()`**: Queues an entity to be destroyed.
- **`getQuery()`**: Retrieves a cached query.

#### Workflow in Practice

Core idea is to perform the expensive work of interpreting and laying out data **once** during initialization, and then reuse that compiled "template" during execution.

**1. "Compile" Payloads in `init()`**

In a system's `init()` method, call `this.compile()` to create and store payload templates for any entities you'll need to work with.

```javascript
// In a system's init() method:

// Compile a payload from a component object.
// This creates a template for a projectile with default position and velocity.
this.projectilePayload = this.compile({
	position: { x: 0, y: 0 },
	velocity: { x: 0, y: 0 },
	projectileTag: {},
})

// Compile a payload from a prefab name, with overrides.
this.bossPayload = this.compile('enemy_base', {
	overrides: {
		health: { value: 1000, max: 1000 },
		scale: { x: 2, y: 2 },
	},
})
```

**2. "Command" Structural Changes in `update()` / `schedule()`**

In system's logic methods, use the pre-compiled payloads to issue commands.

```javascript
// In a system's update() method:

// --- Example 1: Creating a new entity ---

// Mutate the payload's buffers with runtime data.
this.projectilePayload.buffers.position.x[0] = this.player.x
this.projectilePayload.buffers.position.y[0] = this.player.y
this.projectilePayload.buffers.velocity.x[0] = this.player.directionX * 100

// Issue the command to instantiate one entity from the payload.
this.instantiate(this.projectilePayload)

// --- Example 2: Modifying an existing entity ---

// Let's give an enemy a temporary "empowered" status.
// First, compile the payload for the component to add (can also be done in init).
const empoweredPayload = this.compile({ empowered: { duration: 10 } })

// Issue the command to add the component to a specific entity.
this.addComponent(enemyId, empoweredPayload)
```

### Frame Lifecycle & Deferred Commands

Engine executes systems in distinct groups within a single frame, each with a specific purpose and timing. A system's `frequency` in `systemConfig.js` determines which group it belongs to.

The frame lifecycle proceeds in this fixed order:

1.  **Input Group (`frequency: 'input'`)**
    - **When:** Runs once at the very beginning of the frame.
    - **Context:** Receives a variable `deltaTime` based on the actual time since the last frame.
    - **Purpose:** Ideal for low-latency input processing that needs to happen before any game logic.

2.  **Logic Group (`frequency: 'logic'`)**
    - **When:** Runs on a fixed, deterministic timestep (e.g., 60 times per second), independent of the frame rate. If the game lags, this group may run multiple times in a single frame to catch up.
    - **Context:** Receives a constant `deltaTime` (e.g., `1/60`).
    - **Purpose:** All core gameplay logic (physics, AI, state changes) should be here to ensure deterministic and frame-rate-independent behavior.
    3.  **Timed Groups (`frequency: <number>`)**
    - **When:** Runs on a timer (e.g., `frequency: 10` runs 10 times per second).
    - **Context:** Receives a variable `deltaTime`.
    - **Purpose:** For infrequent logic that doesn't need to run every frame.

3.  **Visuals Group (`frequency: 'visuals'`)**
    - **When:** Runs once at the end of the frame, just before rendering.
    - **Context:** Receives a variable `deltaTime` and an `alpha` value (0.0 to 1.0) for interpolating between logic ticks, ensuring smooth motion.
    - **Purpose:** For any logic tied to rendering, such as camera movement, animations, and synchronizing game state to visual representations.

#### Command Buffer Execution Point

All deferred commands recorded by systems (e.g., `instantiate`, `addComponent`, `destroyEntity`) are executed automatically in a single batch **between the Logic Group and the Visuals Group**. This ensures that all structural changes from gameplay logic are completed before any rendering-related systems run.

### Prefab Definitions

Engine uses a **manifest-driven** approach for prefabs. A central manifest ([`prefabs.manifest.json`](app/client/Data/prefabs.manifest.json)) maps a human-readable `prefabName` to a `.json` file. This decouples game logic from the file system.

```javascript
// Instantiate using a prefab name:
const sword = ecs.instantiate('obsidian_sword', {
	/* component overrides */
})
```

### Immediate-Mode API: `ecs` Object

For debugging, testing, and setup, the global `ecs` object provides an immediate-mode API. These operations execute instantly and are less performant than using the deferred `commands` buffer inside systems. This API should not be used in performance-critical code.

_Note: The immediate-mode API is subject to change as thread-safe and console-specific variants are developed._

**Getting Numeric IDs**

```javascript
// Get a map of all component names to their numeric Type IDs.
const { position, velocity } = ecs.getComponentIDs()

// Get a map of kernel function names to their numeric IDs.
const { pathfindingKernel } = ecs.getKernelIDs()
```

**Immediate-Mode Commands**

```javascript
// Create an entity with components
const newId = ecs.createEntity({ position: { x: 10, y: 20 } })

// Add/remove components
ecs.addComponent(newId, 'Health', { value: 100 })
ecs.removeComponent(newId, 'Position')

// Destroy an entity or instantiate a prefab
ecs.destroyEntity(newId)
const sword = ecs.instantiate('obsidian_sword')
```

## Acknowledgements

Inspired by ECS engines like Unity DOTS and Bevy.
