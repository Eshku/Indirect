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

- Relational Queries
- Thread safe everything that could \ should be thread safe.
- Dynamic \ packed arrays.
- Priority Queue
- Serialization/Deserialization
- Allow to redefine default execution order within systems.
- HMR
- Demo and proper documentation
- Pray [proposal-structs](https://github.com/tc39/proposal-structs) is implemented.

## Vision & Principles

Long-term vision is to build a high-performance, **data-oriented**, and **parallel** Entity-Component-System (ECS) in JavaScript.

#### Guiding Principles

1.  **Performance Over "Comfort"**: Design decisions always prioritize raw performance and efficient data access patterns over comfy API.

2.  **Maximum Developer Control**: Goal is to provide as many tools and much control to developers as possible.

3.  **Zero-Cost Abstractions (Pay Only For What You Use)**: Actively avoiding adding features to the core engine if they impose runtime performance penalty on _all_ users, regardless of whether they use the feature. New abstractions are only acceptable if they have a negligible or zero-cost runtime cost for those who don't opt into them.

## Tech Stack

- **Electron**: Main application framework.
- **Vanilla JavaScript**: Core language.

## Architecture

- **Entity**: A simple ID representing a game object.
- **Component**: A schema defining a piece of data associated with an entity.
- **Archetype**: A unique combination of components. All entities with same set of components belong to same archetype.
- **[System](app/client/Systems)**: A class containing game logic that operates on entities.
- **[Kernel](app/client/Kernels)**: A pure function containing logic designed to be run in parallel on worker threads.
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

Systems use queries to find chunks that have a specific set of components.

- **`with`**: Components that must be present.
- **`without`**: Components that must not be present.
- **`any`**: At least one of these components must be present.
- **`react`**: Query only returns chunks where one of these components has changed since system last ran.

Primary way to iterate is `query.iter()`, which yields [`Chunk Views`](app/client/Managers/QueryManager/ChunkView.js) for processing.

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

1.  **Job Creation**: The `schedule()` method of all active systems is called on the main thread. It uses a `JobWriter` to populate a shared job buffer. This step only *defines* the work.
2.  **`update()`**: The `update()` method of systems runs on the main thread. It is used for any logic that must run sequentially before parallel kernels begin.
3.  **Kernel Execution**: Kernel jobs created during job creation phase are now executed in parallel across worker threads.
4.  **`process()`**: The `process()` method runs on the main thread after all of a system's `update()` and kernel jobs have finished.

**Declaring Dependencies:**

System declares its data access patterns and dependencies in a `static dependencies` object. The key for each entry must match the kernel function's name.

- **`reads`/`writes`**: An array of component Type IDs. Informs scheduler about data access to prevent race conditions.
- **`context`**: A plain object containing static data passed to a kernel.
- To define execution order _between systems_, a class can declare `static runsAfter = [OtherSystemID]`.

**System & Kernel Example:**

This example shows a `PhysicsSystem` that schedules a kernel to apply gravity.

**1. Kernel (`/app/client/Kernels/`)**

A kernel is a pure function that runs on a worker, receiving all its data via arguments. Frame-specific data is available on `self.frameContext`, and thread-safe helpers are on the global `parallel` object.

```javascript
/**
 * A "kernel" function that applies gravity and updates position.
 * @param {number} payload - chunkId to process, passed from the job definition.
 * @param {object} systemContext - Read-only data from system's static dependencies `context` block.
 * @param {object} kernelContext - Thread-local helpers, like getScratchBuffer.
 */
export function applyGravityAndMove(payload, systemContext, kernelContext) {
	// Frame-specific data is globally available on the worker.
	const { deltaTime, currentTick } = self.frameContext
	// System-specific static data is passed in.
	const { gravity, position, velocity } = systemContext

	// Use the global helper to get a view into the chunk's data.
	const chunk = parallel.getChunkView(payload)
	const positions = chunk.componentData[position]
	const velocities = chunk.componentData[velocity]

	for (let i = 0; i < chunk.size; i++) {
		// Apply gravity to velocity
		velocities.y[i] += gravity * deltaTime

		// Apply velocity to position
		positions.x[i] += velocities.x[i] * deltaTime
		positions.y[i] += velocities.y[i] * deltaTime
	}

	// Mark modified components as dirty for reactive queries.
	chunk.markDirty(position, currentTick)
	chunk.markDirty(velocity, currentTick)
}
```

**2. System (`/app/client/Systems/`)**

The System class orchestrates work from main thread.

```javascript
const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

// Get numeric IDs for components and kernels at initialization.
const { position, velocity } = ecs.getTypeIDs()
const { applyGravityAndMove } = ecs.getKernelIDs()

export class PhysicsSystem {
	// Declare all data access and execution dependencies statically.
	static dependencies = {
		// The key 'applyGravityAndMove' must match the kernel function name.
		applyGravityAndMove: {
			reads: [velocity],
			writes: [position, velocity],
			// Pass a gravity constant and component IDs to the kernel's `systemContext`.
			context: {
				gravity: -9.81,
				position: position,
				velocity: velocity,
			},
		},
	}

	init() {
		// Use the injected getQuery method to create a query.
		this.query = this.getQuery({ with: [position, velocity] })
	}

	// Runs on the main thread to schedule concurrent jobs for the frame.
	schedule(jobWriter, frameContext) {.
		// Runs applyGravityAndMove function for every chunk on this.query in parallel.
		jobWriter.scheduleForEachChunk(this.query, applyGravityAndMove)
	}
}
```

### [System API Extensions](app/client/Core/Extends/systemExtends.js)

Set of common methods are injected into every system instance. These provide direct access to core engine features like queries and deferred commands.

Key injected methods include:

- **`getQuery()`**: Retrieves a cached query.
- **`createEntity()`**: Queue an entity to be created.
- **`destroyEntity()`**: Queue an entity to be destroyed.
- **`addComponent()`**: Queue component to be added.

### Deferred Structural Changes

All structural changes (creating/destroying entities, adding/removing components) are deferred. When a system calls a method like `createEntity`, it records a command in a `CommandBuffer` to be executed at the end of a frame.

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
const { position, velocity } = ecs.getTypeIDs()

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

Inspired by ECS engines like Unity DOTS and Bevy.
