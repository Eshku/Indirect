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

- **Primitives**: `f64`, `f32`, `i32`, `u32`, `i16`, `u16`, `i8`, `u8`, `u64`.
- **`string`**: Interned string data, stored as a `u32` reference.
- **`enum`**: For mutually exclusive states, defined with a key-value object.
- **`bitmask`**: For properties that can have multiple states simultaneously.
- **`flat_array`**: For fixed-size collections of simple data.
- **Tag Components**: An empty schema `{}` that serves only as a marker for queries.

### Queries

Systems use queries to find entities that have a specific set of components.

- **`with`**: Components that must be present.
- **`without`**: Components that must not be present.
- **`any`**: At least one of these components must be present.
- **`react`**: Query only returns entities where one of these components has changed since system last ran.

Primary way to iterate is `query.iter()`, which yields [`Chunk Views`](app/client/Managers/QueryManager/ChunkView.js) for processing.

### Parallelism: A Kernel-Based Job Scheduler

Engine uses a hybrid parallel job scheduler that separates main-thread **orchestration** (in a System) from parallel **execution** (in a Kernel).

- **System Class (`.js`):** Lives on main thread. It defines queries and schedules jobs for a frame.
- **Kernel Module (`/app/client/Kernels/*.js`):** A plain JavaScript module containing a pure "kernel" function that executes on a workers in parallel.

**System Lifecycle & API:**

System methods are executed in a specific, guaranteed order. An `async init()` method is preferred over a `constructor` for setup logic, as it runs after the System API is injected.

- **`init()`**: (Optional) `async` method for one-time setup. A system has access to its API here.
- **`update(frameContext)`**: (Optional) Runs on **main thread**. For logic that cannot be parallelized.
- **`schedule(frameContext)`**: (Optional) Runs on **main thread** to create and return an array of jobs for the scheduler. This is a job factory.
- **`process(frameContext)`**: (Optional) Runs on **main thread** after all other jobs for this system are complete. It's a finalizer.
- **`destroy()`**: (Optional) `async` method for cleanup.

**Execution Order:**

1.  **`schedule()`**: Creates and returns job definitions. It does not contain game logic itself, but defines work to be done.
2.  **`update()`**: Runs on the main thread after `schedule()`. It is used for any logic that must run sequentially before parallel kernels begin.
3.  **Kernel Execution**: Kernel jobs created by `schedule()` are now executed in parallel.
4.  **`process()`**: Runs on the main thread after all of the system's `update()` and kernel jobs have finished.

**Declaring Dependencies:**

A system declares its data access patterns and dependencies in a `static dependencies` object.

- **`reads`/`writes`**: An array of component Type IDs. Informs scheduler about data access to prevent race conditions.
- **`context`**: A plain object containing static data passed to a kernel.
- To define execution order _between systems_, a class can declare `static runsAfter = [OtherSystemID]`.

**System & Kernel Example:**

This example shows a `PhysicsSystem` that schedules a kernel to apply gravity.

**1. Kernel (`/app/client/Kernels/physicsKernels.js`)**

A kernel is a pure function that runs on a worker, receiving all its data via arguments. Frame-specific data is available on `self.frameContext`.

```javascript
/**
 * A "kernel" function that applies gravity and updates position.
 * @param {number} payload - chunkId to process, passed from the job definition.
 * @param {object} systemContext - Read-only data from system's static dependencies `context` block.
 * @param {object} kernelContext - Helpers, like getChunkView.
 */
export function applyGravityAndMove(payload, systemContext, kernelContext) {
	// Frame-specific data is globally available on the worker.
	const { deltaTime, currentTick } = self.frameContext
	// System-specific static data is passed in.
	const { gravity, position, velocity } = systemContext

	// Use the helper to get a view into the chunk's data.
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

	// Mark modified components as dirty for reactive queries.
	chunk.markAllDirty(position, currentTick)
	chunk.markAllDirty(velocity, currentTick)
}
```

**2. System (`/app/client/Systems/`)**

The System class orchestrates work from main thread.

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

	// Runs on the main thread to generate concurrent jobs for a frame.
	schedule(frameContext) {
		const jobs = []
		const chunkIds = this.query.getChunks()

		// Create one job for each chunk of entities.
		for (const chunkId of chunkIds) {
			jobs.push({ kernel: applyGravityAndMove, payload: chunkId })
		}
		return jobs
	}
}
```

### [System API Extensions](app/client/Core/Extends/systemExtends.js)

To reduce boilerplate, common functionalities are automatically added to every system by instance before its `init()` method is called.

Injected properties include:

- **`this.getQuery()`**: Creates a query.
- **`this.commands`**: Access to the deferred command buffer for structural changes.
- **`this.compileEntity()`**: Compiles an entity definition into a binary payload for `commands`.

### Command Buffer: Safe Structural Changes

The `commands` object, available in a system's `update` and `process` methods, provides a deferred, thread-safe way to perform structural changes (creating/destroying entities, adding/removing components). Changes are queued and executed at a safe point in the frame.

```javascript
// In a system's init method:
const { payload, mutators } = this.compileEntity({
	position: { x: 0, y: 0 },
})
this.entityPayload = payload
this.entityMutators = mutators

// In an update or process method:
this.entityMutators.position.x[0] = 10
this.entityMutators.position.y[0] = 20
this.commands.createEntity(this.entityPayload) // Queue entity creation

// Other commands:
this.commands.setComponentData(entityId, componentPayload)
this.commands.removeComponent(entityId, positionTypeID)
this.commands.destroyEntity(entityId)
```

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
