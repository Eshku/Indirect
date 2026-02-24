# JavaScript Hybrid ECS Electron Game Engine Thing

## Table of Contents

- [Introduction](#introduction)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Key Features and Design Patterns](#key-features-and-design-patterns)
- [Acknowledgements](#acknowledgements)
- [Roadmap and Future Directions](#roadmap-and-future-directions)

## Introduction

**Set expectation low.**

Wobbly foundation of what could be an engine, expect bugs and unfinished features, alot of things are not tested and still changing.

Expect each update to introduce breaking changes, even if they are marked as "patch" or "minor". Versioning is not tied to npm conventions.

Readme might be outdated.

**Current state** - **Experimental** partially parallel \ concurrent ECS with basic functionality and lots of bad practices in place.

**Potential future improvements:**:

- Dynamic (packed) arrays.
- Relational Queries
- Parallel command buffer
- Custom Jobs to run in parallel.
- Thread-safe sharad component data.
- Priority Queue (Min-Heap?) to manage time-based events, as alternative to reducing timers per entity in systems.
- React on component addition \ changes \ removal.
- Serialization \ Deserialization.
- Demo.
- HMR is going to come later on as foundation is less wobbly.
- Make proper readme / documentation.

## Tech Stack

- **Electron** - Main application framework.
- **Pixi.js** - 2D rendering engine, but could be changed to any other rendeding engine, we are using our own update loops.
- **Vanila Javascript** - Yes.

## Architecture

### Core: Entity-Component-System (ECS) Hybrid

- **Entity**: ID representing game object.
- **Component**: Class that acts as a **schema** for component data, defining how it's stored in TypedArrays.
- **Archetype**: All entities with exact same set of components are categorized under same archetype.
- **[System](app/client/Systems)**: Container for logic. Systems operate on entities that have a specific set of components.
- **[Managers](app/client/Managers)**: Storage of some resource, API to interact with it.
- **[Service](app/client/Services)**: Glorified set of on-demand utilities.

#### Architecture: Archetypes and Chunks

The engine's core is built on a data-oriented design that organizes memory for maximum performance. This is achieved through **Archetypes** and **Chunks**.

**Archetypes** define the "shape" of an entity. An archetype represents a unique combination of components. All entities with exact same set of components belong to the same archetype. This grouping is managed automatically by the ECS.

- **Immortal Archetypes:** Archetype definitions are "immortal." Once an archetype is created (e.g., by creating an entity with a new combination of components), it is never destroyed, even if it contains no entities. This avoids the performance cost of "archetype churn" (repeatedly creating and destroying archetypes), which would force `QueryManager` to constantly re-evaluate all active queries.

Each archetype's data is organized into fixed-size **[Chunks](./app/client/ECS/ArchetypeManager/Chunk.js)**. Chunk is a contiguous block of memory that directly stores entities and their associated component data in **Structure of Arrays (SoA)** layout.

- **Direct Data Storage:** Chunk holds:
  - An array of entity IDs.
  - Dedicated `TypedArray`s for each component property (e.g., all `position.x` values in one array, all `position.y` in another). This is the SoA layout.
  - Metadata for tracking component modifications.
- **Memory Allocation:** Component data within Chunks is allocated using `SharedArrayBuffer`, facilitating zero-copy data transfer and enabling multi-threaded processing with Web Workers.
- **Iteration Foundation:** Systems iterate over these Chunks, processing entities and their data in contiguous, cache-friendly blocks of memory.

## Key Features and Design Patterns

### Data Handling

#### [Component](./app/client/Components/) Schemas and Data Access

Components are defined as plain JavaScript objects that act as a schema. This schema dictates how component data is stored and accessed. Complex data types are stored as numeric references to objects managed elsewhere.

A component file exports a named constant matching component's name.

Below are several examples of component schemas, demonstrating various data types and features.

_Example `PlayerTag` (Tag Component):_

```javascript
export const PlayerTag = {}
```

_Example `Health` (Primitives with Defaults):_

```javascript
export const Health = {
	value: { type: 'f32', default: 100 },
	max: { type: 'f32', default: 100 },
}
```

_Example `Name.js` (String):_

```javascript
export const Name = {
	name: { type: 'string', default: 'No Name Defined' },
}
```

_Example `Damage` (Parallel Arrays):_

```javascript
export const Damage = {
	types: {
		type: 'flat_array',
		capacity: 5,
		of: {
			type: 'enum',
			of: {
				Physical: 0,
				Fire: 1,
				Ice: 2,
				Lightning: 3,
				Poison: 4,
			},
		},
	},
	baseValues: {
		type: 'flat_array',
		of: 'f32',
		capacity: 5,
	},
	formulas: {
		type: 'rpn',
		streamCapacity: 128, // Total tokens for all formulas
		instanceCapacity: 5, // Max number of formulas
	},
}
```

_Example `StatusEffects` (Bitmask):_

```javascript
export const StatusEffects = {
	flags: {
		type: 'bitmask',
		of: {
			NONE: 0,
			STUN: 1 << 0,
			ROOT: 1 << 1,
			SILENCE: 1 << 2,
		},
		default: 0, // Default to no active effects
	},
}
```

_Example `State` (Enum):_

```javascript
export const State = {
	state: {
		type: 'enum',
		of: {
			IDLE: 0,
			WALKING: 1,
			ATTACKING: 2,
			JUMPING: 3,
		},
		default: 0, // Default to IDLE
	},
}
```

_Example `Hotbar.js` (Fixed-size Array):_

```javascript
export const Hotbar = {
	slots: {
		type: 'flat_array',
		of: 'entity',
		capacity: 10,
		default: [],
	},
}
```

**Schema Property Definition:**

Every property in a schema must be an object containing a `type` and an optional `default` value.

- **`type`**: A string specifying data type.
- **`default`**: A default value to use for property when a component is added without specifying a value. If omitted, a zero-equivalent (0, false, "") is used.
- **`shared`**: A boolean. If `true`, this property's data is shared across all entities that have same value for it.

**Schema Types:**

- **Primitive Types:** For simple numeric properties. These are most common types, directly mapping to `TypedArray`s.
  - **Definition:** `{ type: 'f64' }`
  - **Supported Types:** `f64`, `f32`, `i32`, `u32`, `i16`, `u16`, `i8`, `u8`, `boolean`, `u64`, `entity`.

- **`string`:** For string data. Engine stores a single copy of each unique string and uses an integer reference (`u32`) to it.
  - **Definition:** `{ type: 'string' }`
  - All strings are **interned**. This means that each unique string (e.g., "Magic Missile", "Player_Character_Name") is stored only once in a global table, and component itself stores a lightweight numeric ID (a `u32` reference) pointing to that string.

- **`enum`:** For properties that can only be one of a set of mutually exclusive values.
  - **Definition:** `{ type: 'enum', of: { STATE_A: 0, STATE_B: 1 } }`
  - `of` property must be an object where keys are string names and values are their explicit numeric representations.
  - Storage type (`u8`, `u16`, `u32`) is automatically inferred.

- **`bitmask`:** For properties that can have multiple states simultaneously.
  - **Definition:** `{ type: 'bitmask', of: { FLAG_A: 1 << 0, FLAG_B: 1 << 1 }, default: 1 << 0 }`
  - `of` property must be an object where keys are flag names and values are their explicit integer bit values.
  - Storage type (`u8`, `u16`, `u32`) is automatically inferred.
  - `default` value must be a number, typically a bitwise combination of the values from the `of` object (e.g., `(1 << 0) | (1 << 1)`).
  - A static lookup object is generated for readable bitwise operations in systems.

- **`rpn`:** For storing Reverse-Polish Notation (RPN) formulas as a stream of tokens. Used for complex, data-driven calculations.
  - **Definition:** `{ type: 'rpn', streamCapacity: 128, instanceCapacity: 5 }`

- **`flat_array`**: For fixed-size collections of simple data.
  - **Definition:** `{ type: 'flat_array', of: 'u32', capacity: 10 }`.
  - Flattens the array into individual properties (e.g., `myArray0`, `myArray1`, ...) within the component's `TypedArray`s. An implicit `_count` property is also created.

- **Tag Components:** A component with an empty schema (`{}`). It contains no data and serves only as a marker for queries (e.g., `PlayerTag`, `EnemyTag`).

### [Queries](app/client/Managers/QueryManager/Query.js)

Queries are used by Systems to find and iterate over entities that possess a specific set of components. They are defined using a combination of component requirements.

**Query Criteria:**

When creating a query using `queryManager.getQuery()`, you provide an object specifying component requirements using their numeric Type IDs:

- **`with`**: An array of component Type IDs that _must_ be present on an entity.
- **`without`**: An array of component Type IDs that _must not_ be present.
- **`any`**: An array of component Type IDs where at least one _must_ be present.
- **`react`**: An array of component Type IDs. The query will only yield entities where one of these components has changed. These components are also implicitly added to `with`.

**Query Iteration Methods:**

Primary way to iterate over entities is `query.iter()`, which yields `Chunk` objects, allowing systems to process data in cache-friendly blocks.

- **Normal Iteration**: Yields all `Chunk`s from archetypes that structurally match the query.
- **Reactive Iteration**: If `react` is used, `query.iter()` only yields `Chunk`s where a `react` component has been modified. Inside the loop, `query.hasChanged(chunk, indexInChunk)` can check if a specific entity's reactive components have changed.

### Parallel System Execution & Phased Updates

The engine features a parallel job scheduler that allows system logic to be executed across multiple CPU cores. To support this, systems are written using a **phased execution model**. System can have up to three distinct phases: `update`, `schedule`, and `process`.

#### System Lifecycle & Method Signatures

System's lifecycle is composed of several methods, each with a specific purpose and signature.

1.  **`constructor()`**: Called once when the system class is first instantiated. Ideal for setting up queries and caching component Type IDs.
2.  **`async init()`**: An optional method for one-time setup that requires `await`.
3.  **`update(context)`**: An optional method that runs on the **main thread** once per frame, before any parallel work for this system begins. The `context` object contains per-frame data like `deltaTime` and `currentTick`. This phase has access to `this.commands`.
4.  **`schedule(chunk, context)`**: An optional method that runs in **parallel on worker threads**. The scheduler creates a separate `schedule` job for each `Chunk` in the system's `scheduleQuery`. This is where all heavy, parallelizable computation should go.
5.  **`process(context)`**: An optional method that runs on the **main thread** after all `schedule` jobs for this system have completed. Ideal for collecting results, aggregation, or finalization. This phase has access to `this.commands`.
6.  **`async destroy()`**: An optional method called when a system is removed (e.g., during Hot Module Replacement). Use this to clean up any resources, listeners, or intervals.

#### Execution Order: `runsAfter` & `runsBefore`

`static` properties enforce sequence between systems. These declarations have the highest authority in the scheduler.

- **`static runsAfter = ['OtherSystem']`**: Guarantees this system will only start after all jobs from `OtherSystem` have finished.
- **`static runsBefore = ['AnotherSystem']`**: The inverse of `runsAfter`. This is automatically translated into a `runsAfter` dependency on `AnotherSystem`.

The engine will detect and throw an error if you create a conflicting or circular dependency (e.g., System A runs after B, but B runs after A).

#### The `context` Object

All phased update methods (`update`, `schedule`, `process`) receive a `context` object. This object is the primary way to access per-frame data and system-specific properties. You can access its properties in two ways:

1.  **Destructuring (Recommended):** `const { deltaTime, gravity } = context;`
2.  **Direct Access:** `const dt = context.deltaTime;`

The `context` object contains the following properties:

- `deltaTime`: The time elapsed since the last update for this system's group. For the `'logic'` group, this is a **fixed** value (e.g., `1/60`). For `'visuals'` and `'input'` groups, this is a **variable** value corresponding to the real frame time.
- `alpha`: An interpolation factor (a value between `0.0` and `1.0`). This is only meaningful for systems in the `'visuals'`.
- `currentTick`: The current fixed-step logic tick number of the game loop.
- `lastTick`: The last tick number when this system's group was previously executed.
- **System-Specific Properties (for `schedule` only):** For the parallel `schedule` method, `context` object is augmented with any properties from the system's instance (`this`) that were declared in the `static dependencies.schedule.context` array.
  - **IMPORTANT:** These properties sent to workers **once** during initialization (or during a hot-swap). They are treated as **immutable** during runtime. If you change a primitive property (e.g., `this.gravity = -10;`) in the `update` method, the workers will **not** see the new value.
  - To pass mutable data between `update` and `schedule` within the same frame, you must use a `SharedArrayBuffer`-backed `TypedArray`. The reference to the buffer is passed once, but its contents can be safely modified and read by both the main thread and workers using `Atomics`.

#### Declaring Dependencies for Parallelism

To manage parallel execution safely, each system must declare its data access patterns and any properties it needs in the parallel context. This is done in a `static dependencies` block.

- **`reads`/`writes`**: An array of component names. This tells the scheduler how to avoid data races between systems.
- **`context`**: An array of property names from the system's instance (`this`) that need to be available in the parallel `schedule` method.

#### `schedule` Method:

- **Signature:** `schedule(chunk, context)`
  - `chunk`: A `ChunkView` object providing access to the component data for this specific job.
  - `context`: An object containing per-frame data (`deltaTime`, `currentTick`) and any system properties you declared in `static dependencies.schedule.context`.
- **Limitations:**
  - **`this` Context is Transpiled (bit of magic):** You can and should write code like `this.speed` inside your `schedule` method. The engine's build-time transpiler will automatically convert this to `context.speed` and ensure the value is passed to the worker. **This is a critical concept.** Because the `schedule` method runs in a different thread with a different scope, it cannot directly access the system instance or module-level variables from the main thread. The transpiler bridges this gap by making `this` properties available on the `context` object. Trying to use a module-scoped variable for a dependency (e.g., `const gravity = -9.81;`) will fail in `schedule`, as that variable only exists on the main thread.
  - **Context Property Restrictions:** Only primitive values (numbers, strings, booleans, bigints) and `SharedArrayBuffer`-backed `TypedArray`s can be passed as context properties. No objects.
  - **No `this.commands`:** Structural changes (creating/destroying entities, adding/removing components) are strictly forbidden inside `schedule`. All such operations must be deferred to the `update` or `process` methods, which run on the main thread and have access to `this.commands`.

#### System Example

```javascript
const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager } = ecs

export class GravitySystem {
	// 1. Control-Flow Dependencies
	// This system must run after MovementSystem to apply gravity to the new positions.
	static runsAfter = ['MovementSystem']

	// 2. Data-Flow & Context Dependencies
	// Declare what the system reads/writes and what properties it needs in parallel.
	static dependencies = {
		schedule: {
			reads: ['position'],
			writes: ['velocity'],
		},
	}

	constructor() {
		// Assign components to "this" context by name.
		ecs.assignComponents(this, ['position', 'velocity'])
		// Access by this.position, this.velocity, etc.

		// if you only need component type ID - there is a method for that too.
		// const { position, velocity } = ecs.getTypeIDs()

		// This query will be used to create parallel `schedule` jobs.
		// Quary name has to be exactly "scheduleQuery".
		this.scheduleQuery = queryManager.getQuery({ with: [this.position, this.velocity] })

		// This property is used in `schedule`, so its value will be transpiled and sent to workers
		// once during initialization or after HMR.
		this.gravity = -9.81
	}

	update(context) {
		// const dt = context.deltaTime;
		// ... main-thread logic ...
	}

	// This runs on worker threads for each chunk matching the scheduleQuery.
	schedule(chunk, context) {
		const velocities = chunk.componentData[this.velocity]

		const { deltaTime, gravity } = context

		for (let i = 0; i < chunk.size; i++) {
			velocities.y[i] += gravity * deltaTime
		}
	}

	process(context) {
		//optional method, runs after schedule.
	}
}
```

### Working with Enums and Bitmasks

Engine provides native support for defining and working with enumerations and bitmasks directly within component schemas.

When a schema with an `enum` or `bitmask` is compiled, the `ComponentManager` makes the `of` object available as a lookup table via `componentManager.getConstantsFor('ComponentName')`. This allows for readable code without sacrificing performance.

```javascript
export class CombatSystem {
	constructor() {
		const { WeaponState, StatusEffects } = componentManager.getTypeIDs()
		this.query = queryManager.getQuery({
			with: [WeaponState, StatusEffects],
		})

		this.weaponStateTypeID = WeaponState
		this.statusEffectsTypeID = StatusEffects

		// Get the lookup objects for readable code.
		this.weaponState = componentManager.getConstantsFor('WeaponState')
		this.statusEffects = componentManager.getConstantsFor('StatusEffects')
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const weaponStateArrays = chunk.componentArrays[this.weaponStateTypeID]
			const statusEffectsArrays = chunk.componentArrays[this.statusEffectsTypeID]

			for (const entityIndex of chunk) {
				const currentState = weaponStateArrays.state[entityIndex]
				const currentFlags = statusEffectsArrays.flags[entityIndex]

				// Use cached lookup objects for readable comparisons.
				const isStunned = (currentFlags & this.statusEffects.STUNNED) !== 0

				if (currentState === this.weaponState.IDLE && !isStunned) {
					// Write raw integer value for enum.
					weaponStateArrays.state[entityIndex] = this.weaponState.ATTACKING
				}
			}
		}
	}
}
```

### Command Buffer: Safe Structural Changes

**Important:** The `commands` object is only available in the `update` and `process` methods of a system, which run on the main thread. The parallel `schedule` method **does not** have access to the command buffer to ensure thread safety.

Command Buffer is a mechanism for managing structural changes (adding/removing components, creating/destroying entities). It solves concurrency and data consistency issues by recording all change requests and executing them in a safe, sorted, and consolidated manner at the end of the frame.

Workflow is:

1.  **Compile a Payload:** In a system's constructor, define an entity "template" and compile it once into a `payload`. This payload also contains `mutators`.
2.  **Mutate (Optional):** In `update` loop, use `mutators` to change parts of payload. Mutators are `TypedArray` views that modify payload's underlying `ArrayBuffer` directly.
3.  **Command:** Pass pre-compiled payload to a command buffer method like `createEntity()`, `addComponent()`, or `setComponentData()`.

**Example: Creating a Single Entity**

```javascript
// In a system's constructor:
// Compile payload once.
const { payload, mutators } = payloadCompiler.compileEntity({
	Position: { x: 0, y: 0 },
	Velocity: { x: 0, y: 0 },
	Sprite: { texture: 'projectile_sprite' },
})

this.projectilePayload = payload
this.projectileMutators = mutators

// In update loop:
// 2. Use mutators to update binary data with zero allocations.
this.projectileMutators.position.x[0] = player.x
this.projectileMutators.position.y[0] = player.y
this.projectileMutators.velocity.vx[0] = aimVector.x * 1000
this.projectileMutators.velocity.vy[0] = aimVector.y * 1000

// 3. Command creation of an entity from mutated payload.
this.commands.createEntity(this.projectilePayload)
```

**Example: Adding/Setting a Component**

Same pattern applies to adding or setting component data.

```javascript
// In a system's constructor:
const { payload, mutators } = payloadCompiler.compileComponent(positionTypeID, { x: 0, y: 0 })

this.positionPayload = payload
this.positionMutators = mutators

// In the update loop:
this.positionMutators.position.x[0] = newX
this.positionMutators.position.y[0] = newY

// This command works for both adding a new component and updating an existing one.
this.commands.setComponentData(entityId, this.positionPayload)

// Create a batch of identical entities (using an un-mutated payload)
this.commands.createEntities(this.staticPayload, 100)

// Remove a component
this.commands.removeComponent(entityID, this.positionTypeID)

// Destroy an entity
this.commands.destroyEntity(entityID)
```

**Placeholder Entities: Creating and Referencing Entities in the Same Frame**

A common scenario in ECS is needing to create several entities that reference each other in the same frame.

When `this.commands.createEntity(payload)` called, it returns a temporary **placeholder ID**. This placeholder acts as a handle you can use in other commands recorded during the same frame.

### Prefab Definitions: Manifest-Driven Approach

Engine uses **manifest-driven** approach for defining and creating entities. Instead of referencing file paths directly - it is using human-readable string called a `prefabName` (e.g., `"obsidian_sword"`, `"player_character"`).

This design decouples game logic from file system structure, making project easier to maintain, and opens the door for future easy modding and powerful developer console commands (`spawn obsidian_sword`).

#### Prefab Manifest

Core of this system is [app/client/Data/prefabs.manifest.json](./app/client/Data/prefabs.manifest.json) file. This file acts as a central registry for all entities in the game. It maps each `prefabName` to its source, which can be either a data file (`.json`) or a programmatic factory (`.js` module and function).

**Example `prefabs.manifest.json`:**

```json
{
	"player_character": {
		"module": "app/client/Data/Prefabs/Playable/Player.js"
	},
	"fireball": {
		"path": "[app/client/Data/Prefabs/Items/Skills/Fireball.json](./app/client/Data/Prefabs/Items/Skills/Fireball.json)"
	},
	"item_base": {
		"path": "[app/client/Data/Prefabs/Items/Item.json](./app/client/Data/Prefabs/Items/Item.json)"
	}
}
```

**Manifests will be automatically generated later on.**

#### Data-Driven Prefabs

Prefabs are defined in `.json` files. Supports inheritance using `extends` key, which points to another `prefabName`.

_Example `Fireball.json`:_

```json
{
	"extends": "item_base",
	"components": {
		"displayName": { "value": "Fireball" },
		"icon": { "assetName": "fireball_icon" },
		"cooldown": { "duration": 0.25 }
	}
}
```

**Usage in Code**

```javascript
//second argument - overrides
const player = ecs.instantiate('player_character', { position: { x: 50, y: 50 } })
```

This architecture keeps game logic clean and focused on _what_ to create (`'player_character'`) rather than _how_ or _from where_ to create it.

### Async Game Loop & System Update Phases

Engine's `GameLoop` is `async` loop built around `requestAnimationFrame`.

#### Async Game Loop

Primary benefit of `async` loop is ability to `await system.update(...)`. This ensures that any asynchronous operations within a system (like on-demand asset loading) complete fully before next system runs.

- **Predictable Execution Flow**: By `await`ing every system by default, execution flow is sequential and easy to reason about. A system can rely on the fact that all previous systems in frame have completed their work.
- **"Fire-and-Forget" as an Option**: While `await` is default, this architecture still supports non-blocking, "fire-and-forget" async operations. A system can launch an async task (e.g., a network request) without `await`ing it, allowing game loop to continue immediately.
- **Prep for Parallelism**: This design provides foundation for integrating Web Workers.

#### System Update Phases

System scheduling is defined by `frequency` property of each system in [app/client/Managers/SystemManager/systemConfig.js](./app/client/Managers/SystemManager/systemConfig.js). This file is single source of truth for execution order and update frequency. Main frequencies are:

- **`'none'`**: For systems that only need to be initialized. Their constructor and `init()` method are called, but they are never added to any update loop. Ideal for purely event-driven systems (e.g., setting up listeners for external libraries).

- **`Input`:**
  - **When:** Runs first in the frame, once per `requestAnimationFrame` call.
  - **Use For:** Lowest-latency input processing. Ideal for systems that need to react to user actions before any other logic, such as updating a custom mouse cursor's position.

- **`Logic`:**
  - **When:** Runs on a deterministic, fixed timestep (e.g., 60 times per second), independent of rendering frame rate. Loop may run multiple times per frame to catch up, or zero times if frame is too fast.
  - **Use For:** Physics, core gameplay logic, and anything requiring deterministic, reproducible behavior. This ensures game simulation is consistent across different machines and frame rates. This entire phase is a candidate for future parallel execution on a Web Worker.

- **`Timed Groups`:**
  - **When:** Runs on a timer at specified updates-per-second, after `Logic` phase but before `Visuals` phase.
  - **Use For:** Infrequent logic that doesn't need to run every frame, such as certain UI updates, AI decision-making, or performance monitoring.

- **`Visuals`:**
  - **When:** Runs once per visual frame, after all `Logic` and timed updates for that frame are complete. `DeltaTime` can vary.
  - **Use For:** Rendering, visual effects, interpolation between fixed updates (`alpha`), UI updates, and camera movement. This is for logic that needs to be as smooth as display's refresh rate allows.

  **Update Group names are subject to change.**

### Debugging & Immediate-Mode API: [ECS](/app/client/ECS/EntityManager/ECS.js) Object

For debugging, testing, and performing one-off actions outside of systems, the engine exposes a global `ECS` object. This object provides a high-level, immediate-mode API for interacting with the world.

**Important:** This API is for convenience and should **not** be used inside performance-critical systems. For structural changes within a system's `update` loop, always use deferred `commands` object.

#### Inspecting Entities

To inspect an entity's state from developer console, use `ecs.viewEntity(entityID)`. This returns a plain object containing a snapshot of entity's data.

#### Immediate-Mode Commands

[ECS](/app/client/ECS/EntityManager/ECS.js) object also provides methods to modify the world state immediately.

```javascript
// Create a new entity with components
const newEntityId = ecs.createEntity({
	position: { x: 10, y: 20 },
	velocity: { x: 5, y: 0 },
})

ecs.addComponent(newEntityId, Health, { value: 100 })

ecs.removeComponent(newEntityId, Velocity)

ecs.destroyEntity(newEntityId)

const sword = ecs.instantiate('obsidian_sword')
```

## Acknowledgements

Inspired by ECS engines like Unity DoTS and Bevy.
