# JavaScript Hybrid ECS Game Engine

## Table of Contents

- [Introduction](#introduction)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Key Features](#key-features)
- [Acknowledgements](#acknowledgements)

## Introduction

This is a foundation for what could become an engine, built around a hybrid parallel Entity-Component-System (ECS) architecture.

**Current Stage**: Experimental, constantly changing. Expect breaking changes and bugs.

## Potential future improvements:

- Dynamic (packed) arrays
- Relational Queries
- Thread-safe Command Buffer
- Thread-safe Shared Component Data / prototypes.
- Thread safe compiler for Command Buffer.
- Thread safe whatever other API.
- Priority Queue
- Allow to react on component addition/changes/removal as different events.
- Serialization/Deserialization
- Allow to redefine default execution order within systems.
- HMR
- Demo and proper documentation

## Tech Stack

- **Electron**: Main application framework.
- **Pixi.js**: 2D rendering engine.
- **Vanilla JavaScript**: Core language.

## Architecture

- **Entity**: A simple ID representing a game object.
- **Component**: A schema defining a piece of data associated with an entity.
- **Archetype**: A unique combination of components. All entities with the exact same set of components belong to same archetype.
- **[System](app/client/Systems)**: A class containing game logic that operates on entities.
- **[Kernel](app/client/Kernels)**: A pure function containing logic designed to be run in parallel on worker threads.
- **[Manager](app/client/Managers)**: A class that owns a resource and provides an API to interact with it.

### Archetypes and Chunks

Engine's core is a data-oriented design using **Archetypes** and **Chunks**.

An archetype's data is organized into fixed-size **Chunks**. A chunk is a contiguous block of memory that stores entities and their component data in a **Structure of Arrays (SoA)** layout. Component data is allocated in `SharedArrayBuffer`s, enabling zero-copy data access for worker threads. Systems iterate over these chunks, processing data in a cache-friendly manner.

## Key Features

### [Component Schemas](app/client/Components/)

Components are defined as plain JavaScript objects that act as a schema, dictating how data is stored.

- **`PlayerTag` (Tag Component):**
  ```javascript
  export const PlayerTag = {}
  ```
- **`Health` (Primitive Types):**
  ```javascript
  export const Health = {
  	value: { type: 'f32', default: 100 },
  	max: { type: 'f32', default: 100 },
  }
  ```
- **`Name` (String):**
  ```javascript
  export const Name = {
  	name: { type: 'string', default: 'No Name' },
  }
  ```

**Schema Types:**

- **Primitives**: `f64`, `f32`, `i32`, `u32`, `i16`, `u16`, `i8`, `u8`, `boolean`, `u64`, `entity`.
- **`string`**: Interned string data, stored as a `u32` reference.
- **`enum`**: For mutually exclusive states, defined with a key-value object.
- **`bitmask`**: For properties that can have multiple states simultaneously.
- **`flat_array`**: For fixed-size collections of simple data.
- **Tag Components**: An empty schema `{}` that serves only as a marker for queries.

### Queries

Systems use queries to find entities that have a specific set of components.

- **`with`**: Components that _must_ be present.
- **`without`**: Components that _must not_ be present.
- **`any`**: At least one of these components _must_ be present.
- **`react`**: Query only returns entities where one of these components has changed since system last ran.

Primary way to iterate is `query.iter()`, which yields [`Chunk Views`](app/client/Managers/QueryManager/ChunkView.js) for processing.

### Parallelism: A Kernel-Based Job Scheduler

Engine uses a hybrid parallel job scheduler that separates main-thread **orchestration** (in a System) from parallel **execution** (in a Kernel).

- **System Class (`.js`):** Lives on main thread. It defines queries and schedules jobs for a frame.
- **Kernel Module (`/app/client/Kernels/*.js`):** A plain JavaScript module containing a pure "kernel" function that executes on a worker thread.

**System Lifecycle:**

- **`constructor()`**: Called once on instantiation. Used for setting up queries and caching IDs.
- **`init()`**: (Optional) `async` method for one-time setup.
- **`update(frameContext)`**: (Optional) Runs on **main thread**. For logic that cannot be parallelized.
- **`schedule(frameContext)`**: (Optional) Runs on **main thread** to create and return an array of jobs for scheduler.
- **`process(frameContext)`**: (Optional) Runs on **main thread** after all other jobs for this system are complete.
- **`destroy()`**: (Optional) `async` method for cleanup.

**System Execution Order**

Methods of a system are executed in a specific, guaranteed order to manage the interplay between main-thread logic and parallel execution.

1.  **`schedule(frameContext)` (Job Factory Phase)**
    This method is always called first. Its sole purpose is to create and return an array of job definitions (kernels and their payloads) for the scheduler. It runs on the main thread before any other execution phase begins. It does not contain game logic itself, but rather defines the parallel work to be done.

2.  **`update(frameContext)` (Main-Thread Execution)**
    After `schedule()` has defined the jobs, the `update()` method runs on the main thread. It is used for any logic that must run sequentially before the parallel kernels begin.

3.  **Kernel Execution (Parallel Phase)**
    The kernel jobs created by `schedule()` are now executed by the worker threads (or the main thread, if no workers are available). The scheduler ensures these jobs only start after the system's `update()` method is complete.

4.  **`process(frameContext)` (Main-Thread Finalizer)**
    After all of the system's `update()` and kernel jobs have finished, the `process()` method runs on the main thread. It acts as a finalizer, allowing for logic that needs to happen after all other work for that system is complete (e.g., aggregating results from kernels).

**Declaring Dependencies:**

To manage parallel execution safely, a system declares its data access patterns and dependencies in a `static dependencies` object.

- **`reads`/`writes`**: An array of component Type IDs. Informs scheduler about data access to prevent race conditions.
- **`context`**: A plain object containing static data (like configuration or constants) that is passed to a kernel.
- **`runsAfter`**: An array of kernel functions or the string `'update'`. Enforces an explicit execution order _within_ a system's own jobs.

To define execution order _between systems_, a class can declare `static runsAfter = [OtherSystem]`.

**System & Kernel Example:**

This example shows a `PhysicsSystem` that schedules a kernel to apply gravity.

**1. Kernel**

A kernel is a pure function that runs on a worker, receiving all its data via arguments.

```javascript
/**
 * A "kernel" function that applies gravity and updates position.
 * @param {number} payload - chunkId to process.
 * @param {object} systemContext - Read-only data from system's static dependencies.
 * @param {object} kernelContext - Helpers, like getChunkView.
 */
export function applyGravityAndMove(payload, systemContext, kernelContext) {
	const { deltaTime } = frameContext // Global frame context
	const { position, velocity, gravity } = systemContext // System-specific context

	const chunk = kernelContext.getChunkView(payload)
	const positions = chunk.componentData[position]
	const velocities = chunk.componentData[velocity]

	for (let i = 0; i < chunk.size; i++) {
		// Apply gravity to velocity
		velocities.y[i] += gravity * deltaTime

		// Apply velocity to position
		positions.x[i] += velocities.x[i] * deltaTime
		positions.y[i] += velocities.y[i] * deltaTime
	}

	// Mark modified components as dirty.
	chunk.markAllDirty(position, frameContext.currentTick)
	chunk.markAllDirty(velocity, frameContext.currentTick)
}
```

**2. Systems**

System class orchestrates work from main thread.

```javascript
const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()

// Get numeric IDs for components and kernels at initialization.
const { position, velocity } = ecs.getTypeIDs()
const { applyGravityAndMove } = ecs.getKernelIDs()

export class PhysicsSystem {
	// Declare all data access and execution dependencies statically.
	static dependencies = {
		applyGravityAndMove: {
			reads: [velocity],
			writes: [position, velocity],
			// Pass a gravity constant to kernel's `systemContext`.
			context: {
				gravity: -9.81,
				position: position,
				velocity: velocity,
			},
		},
	}

	constructor() {
		this.query = ecs.queryManager.getQuery({ with: [position, velocity] })
	}

	update(frameContext) {
		//Runs every frame.
	}

	// Runs on main thread to generate concurrent jobs for a frame.
	schedule(frameContext) {
		const jobs = []
		const chunkIds = this.query.getChunks()

		// Create one job for each chunk of entities.
		for (const chunkId of chunkIds) {
			jobs.push({ kernel: applyGravityAndMove, payload: chunkId })
		}

		return jobs
	}

	process(frameContext) {
		// Runs every frame after all other jobs for this system are complete.
	}
}
```

### Command Buffer: Safe Structural Changes

`commands` object provides a safe way to perform structural changes (creating/destroying entities, adding/removing components). It is available in a system's `update` and `process` methods, which run on main thread.

Workflow involves compiling a binary `payload` once in constructor, updating it with `mutators`, and then passing it to a command.

```javascript
// In a system's constructor:
const { payload, mutators } = ecs.payloadCompiler.compileEntity({
	Position: { x: 0, y: 0 },
})
this.entityPayload = payload
this.entityMutators = mutators

// In an update or process method:
this.entityMutators.Position.x[0] = 10
this.entityMutators.Position.y[0] = 20
this.commands.createEntity(this.entityPayload) // Create entity from payload

// Other commands:
this.commands.setComponentData(entityId, componentPayload)
this.commands.removeComponent(entityId, positionTypeID)
this.commands.destroyEntity(entityId)
```

### Prefab Definitions

Engine uses a **manifest-driven** approach for prefabs. A central manifest ([`prefabs.manifest.json`](app/client/Data/prefabs.manifest.json)) maps a human-readable `prefabName` (e.g., `"obsidian_sword"`) to a `.json` file. This decouples game logic from file system. Prefabs can extend other prefabs to create complex hierarchies.

```javascript
// Instantiate using a prefab name:
const sword = ecs.instantiate('obsidian_sword', {
	/* component overrides */
})
```

### System Update Groups

System scheduling is defined in `systemConfig.js`. Key update groups are:

- **`Input`**: Runs once per animation frame, for lowest-latency input.
- **`Logic`**: Runs on a fixed timestep (e.g., 60Hz) for deterministic gameplay and physics.
- **`Visuals`**: Runs once per animation frame, after all logic. Used for rendering, interpolation, and other visual updates.

### Debugging & Immediate-Mode API: [`ecs` Object](app/client/ECS/EntityManager/ECS.js)

For debugging and testing, global `ecs` object provides an immediate-mode API. This should **not** be used in performance-critical code; use `commands` object inside systems instead.

**Getting Numeric IDs**

```javascript
// Get a map of all component names to their numeric Type IDs.
const { position, velocity } = ecs.getTypeIDs()

// Get a map of system names to their numeric IDs.
const { PhysicsSystem } = ecs.getSystemIDs()

// Get a map of kernel function names to their numeric IDs.
const { applyGravityAndMove } = ecs.getKernelIDs()
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

Inspired by ECS engines like Unity DoTS and Bevy.
