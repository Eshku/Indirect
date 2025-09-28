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

**Current state** - **Experimental** and **very messy** single threaded ECS with basic functionality and lots of bad practices in place.

**Next significant steps:**

- Introduce dynamic (packed) arrays, stored on chunk (?).
- Placeholder Entities.
- Relational Queries (?)
- Parrallelism.
- Custom HMR, or in simple terms - hot reload.
- Serialization \ Deserialization.
- React on component addition \ changes \ removal as separate things (?)

## Tech Stack

- **Electron** - Main application framework.
- **Pixi.js** - 2D rendering engine, but could be changed to any other rendeding engine, we are using our own update loops.
- **Planck.js** - 2D physics engine. It is there, but it is not yet used ¯\_(ツ)\_/¯
- **Vanila Javascript** - Yes.

## Architecture

### Core: Entity-Component-System (ECS) Hybrid

- **Entity**: ID representing game object.
- **Component**: Class that acts as a **schema** for component data, defining how it's stored in TypedArrays.
- **Archetype**: All entities with the exact same set of components are categorized under same archetype.
- **[System](app/client/Systems)**: Container for logic. Systems operate on entities that have a specific set of components.
- **[Managers](app/client/Managers)**: Storage of some resource, API to interact with it.
- **[Service](app/client/Services)**: Glorified set of on-demand utilities.

#### Archetypes and Chunks: Core of Data Management

[`EntityManager`](./app/client/ECS/EntityManager/EntityManager.js) is the heart of the ECS, responsible for managing all entities, archetypes, and their data.

**Archetypes** define the structure of entities. An archetype represents a unique combination of components. All entities with the exact same set of components belong to the same archetype. This is managed internally by the `EntityManager`.

- **Immortal Archetypes:** Archetype definitions are "immortal." Once an archetype is created (e.g., by creating an entity with a new combination of components), it is never destroyed, even if it contains no entities. This avoids the performance cost of "archetype churn" (repeatedly creating and destroying archetypes), which would force the `QueryManager` to constantly re-evaluate all active queries.

Each archetype's data is organized into fixed-size **[Chunks](./app/client/ECS/ArchetypeManager/Chunk.js)**. A Chunk is a contiguous block of memory that directly stores entities and their associated component data in a Structure of Arrays (SoA) layout.

- **Direct Data Storage:** Chunk holds:
  - An array of entity IDs (`Uint32Array`).
  - Dedicated `TypedArray`s for each component property (e.g., `position.x` values in one array, `position.y` in another).
  - `dirtyTicksArrays` to track component modifications.
- **Memory Allocation:** Component data within Chunks is allocated using `SharedArrayBuffer`, facilitating zero-copy data transfer and enabling multi-threaded processing with Web Workers in the future.
- **Iteration Foundation:** Systems iterate over these Chunks, processing entities and their data in contiguous blocks.

## Key Features and Design Patterns

### Data Handling

#### [Component](./app/client/Components/) Schemas and Data Access

Components are defined as plain JavaScript objects that act as a schema. This schema dictates how component data is stored and accessed. Complex data types are stored as numeric references to objects managed elsewhere.

A component file exports a named constant matching the component's name.

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

- **`type`**: A string specifying the data type.
- **`default`**: A default value to use for the property when a component is added without specifying a value. If omitted, a zero-equivalent (0, false, "") is used.
- **`shared`**: A boolean. If `true`, this property's data is shared across all entities that have the same value for it.

**Schema Types:**

- **Primitive Types:** For simple numeric properties. These are the most common and performant types, directly mapping to `TypedArray`s.

  - **Definition:** `{ type: 'f64' }`
  - **Supported Types:** `f64`, `f32`, `i32`, `u32`, `i16`, `u16`, `i8`, `u8`, `boolean`, `u64`, `entity`.

- **`string`:** For string data. The engine stores a single copy of each unique string and uses an integer reference (`u32`) to it.

  - **Definition:** `{ type: 'string' }`
  - All strings are **interned**. This means that each unique string (e.g., "Magic Missile", "Player_Character_Name") is stored only once in a global table, and the component itself stores a lightweight numeric ID (a `u32` reference) pointing to that string.

- **`enum`:** For properties that can only be one of a set of mutually exclusive values.

  - **Definition:** `{ type: 'enum', of: { STATE_A: 0, STATE_B: 1 } }`
  - The `of` property must be an object where keys are the string names and values are their explicit numeric representations.
  - The underlying storage type (`u8`, `u16`, `u32`) is automatically inferred based on the largest numeric value provided. A static lookup object is generated for readable comparisons.

- **`bitmask`:** For properties that can have multiple states simultaneously.

  - **Definition:** `{ type: 'bitmask', of: { FLAG_A: 1 << 0, FLAG_B: 1 << 1 }, default: 1 << 0 }`
  - The `of` property must be an object where keys are the flag names and values are their explicit integer bit values.
  - The `storageType` (`u8`, `u16`, `u32`) is automatically inferred if not provided.
  - The `default` value must be a number, typically a bitwise combination of the values from the `of` object (e.g., `(1 << 0) | (1 << 1)`).
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

The primary way to iterate over entities is `query.iter()`, which yields `Chunk` objects, allowing systems to process data in cache-friendly blocks.

- **Normal Iteration**: Yields all `Chunk`s from archetypes that structurally match the query.
- **Reactive Iteration**: If `react` is used, `query.iter()` only yields `Chunk`s where a `react` component has been modified. Inside the loop, `query.hasChanged(chunk, indexInChunk)` can check if a specific entity's reactive components have changed.

### System Loop

Systems are classes that encapsulate game logic. They operate on entities that possess a specific set of components, processing their data each frame. The core logic of a system resides within its `update` method.

A system's constructor is the ideal place to get references to managers, set up queries, and cache component Type IDs for use in the hot path.

`Update` method receives `deltaTime` (time elapsed since last frame) and `currentTick`. Within this method, systems typically iterate over entities that match their defined queries.

_Example `ApplyVelocity.js` system:_

```javascript
export class ApplyVelocity {
	constructor() {
		// Get all component Type IDs at once for efficiency.
		const { Position, Velocity } = componentManager.getTypeIDs()

		// Define a query for entities that have both Position and Velocity.
		// The `react` property makes this a reactive query.
		this.query = queryManager.getQuery({
			with: [Position, Velocity],
			react: [Velocity], // Only process entities whose Velocity has changed.
		})

		// Cache the IDs on `this` for fast access in the update loop.
		this.positionTypeID = Position
		this.velocityTypeID = Velocity
	}

	update(deltaTime, currentTick) {
		// Iterate over all Chunks that contain entities matching the query.
		for (const chunk of this.query.iter()) {
			// Get a marker to flag which entities we change.
			const positionMarker = chunk.getDirtyMarker(this.positionTypeID, currentTick)

			// Get direct references to the raw TypedArrays for the components.
			const posArrays = chunk.componentArrays[this.positionTypeID]
			const velArrays = chunk.componentArrays[this.velocityTypeID]

			// Loop through each entity in the chunk.
			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				// Because this is a reactive query, check if the specific entity's
				// Velocity component has changed before doing any work.
				if (this.query.hasChanged(chunk, indexInChunk)) {
					// Apply velocity to position.
					posArrays.x[indexInChunk] += velArrays.x[indexInChunk] * deltaTime
					posArrays.y[indexInChunk] += velArrays.y[indexInChunk] * deltaTime

					// Mark the Position component as dirty so other reactive systems can see the change.
					positionMarker.mark(indexInChunk)
				}
			}
		}
	}
}
```

In the example above, `ApplyVelocity` first retrieves the component Type IDs it needs using `componentManager.getTypeIDs()`. It then uses these IDs to define a **reactive query** that will only yield entities whose `Velocity` component has changed.

The `update` method iterates through chunks, and for each entity, it performs `hasChanged()` check before proceeding. If the check passes, it performs calculation and marks the `Position` component as "dirty," allowing other systems to react to the change.

### Working with Enums and Bitmasks

The engine provides native support for defining and working with enumerations and bitmasks directly within component schemas.

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

				// Use the cached lookup objects for readable comparisons.
				const isStunned = (currentFlags & this.statusEffects.STUNNED) !== 0

				if (currentState === this.weaponState.IDLE && !isStunned) {
					// Write the new raw integer value for the enum.
					weaponStateArrays.state[entityIndex] = this.weaponState.ATTACKING
				}
			}
		}
	}
}
```

### Command Buffer: Safe and Efficient Structural Changes

Command Buffer is a mechanism for managing structural changes (adding/removing components, creating/destroying entities). It solves concurrency and data consistency issues by recording all change requests and executing them in a safe, sorted, and consolidated manner at the end of the frame.

Workflow is:

1.  **Compile a Payload:** In a system's constructor, define an entity "template" and compile it once into a `payload`. This payload also contains `mutators`.
2.  **Mutate (Optional):** In `update` loop, use `mutators` to change parts of payload. Mutators are `TypedArray` views that modify payload's underlying `ArrayBuffer` directly.
3.  **Command:** Pass pre-compiled payload to a command buffer method like `createEntity()`, `addComponent()`, or `setComponentData()`.

**Example: Creating a Single Entity**

```javascript
// In a system's constructor:
// 1. Compile payload once.
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

### Prefab Definitions: Manifest-Driven Approach

Engine uses **manifest-driven** approach for defining and creating entities. Instead of referencing file paths directly - it is using human-readable string called a `prefabName` (e.g., `"obsidian_sword"`, `"player_character"`).

This design decouples game logic from file system structure, making project easier to maintain, and opens the door for future easy modding and powerful developer console commands (`spawn obsidian_sword`).

#### The Prefab Manifest

Core of this system is the [app/client/Data/prefabs.manifest.json](./app/client/Data/prefabs.manifest.json) file. This file acts as a central registry for all entities in the game. It maps each `prefabName` to its source, which can be either a data file (`.json`) or a programmatic factory (`.js` module and function).

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
const player = entityManager.instantiate('player_character', { position: { x: 50, y: 50 } })
```

This architecture keeps game logic clean and focused on _what_ to create (`'player_character'`) rather than _how_ or _from where_ to create it.

### Async Game Loop & System Update Phases

The engine's `GameLoop` is `async` loop built around `requestAnimationFrame`.

#### Async Game Loop

Primary benefit of the `async` loop is the ability to `await system.update(...)`. This ensures that any asynchronous operations within a system (like on-demand asset loading) complete fully before the next system runs.

- **Predictable Execution Flow**: By `await`ing every system by default, execution flow is sequential and easy to reason about. A system can rely on the fact that all previous systems in the frame have completed their work.
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

### Debugging & Immediate-Mode API: [ECS](app/client/Core/ECS/ECS.js) Object

For debugging, testing, and performing one-off actions outside of systems, the engine exposes a global `ECS` object. This object provides a high-level, immediate-mode API for interacting with the world.

**Important:** This API is for convenience and should **not** be used inside performance-critical systems. For structural changes within a system's `update` loop, always use deferred `commands` object.

#### Inspecting Entities

To inspect an entity's state from the developer console, use `ecs.viewEntity(entityID)`. This returns a plain object containing a snapshot of the entity's data.

#### Immediate-Mode Commands

[ECS](app/client/Core/ECS/ECS.js) object also provides methods to modify the world state immediately.

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

## Roadmap and Future Directions

The engine's future development is focused on three interconnected pillars. Many improvements in one area are prerequisites for advancements in others.

### 1. ECS Core Improvements

This involves strengthening the fundamental architecture of the Entity-Component-System for greater performance, flexibility, and robustness.

- **Relational ECS Patterns:** Explore and implement more advanced ECS patterns, like entity hierarchies (`Parent`/`Children` components) and relational queries.
- **Serialization:** Develop a system for serializing and deserializing.
- **Code Quality & Decoupling:** As the foundation stabilizes, refactor the manager-based architecture to reduce tight coupling and improve overall code quality and documentation.
- **Mutable Queries** - Allow queries to be modified at runtime, enabling dynamic filtering and adaptation to changing game states without re-creating queries.

### 2. Transpiler & Developer Experience

A build-time transpiler is the cornerstone for achieving both a high-quality developer experience and maximum runtime performance.

- **Goal: Zero-Cost Abstractions:** The primary goal is to allow developers to write clean, intuitive, object-oriented code using accessors and views, and have the transpiler automatically rewrite it into low-level code (direct `TypedArray` access) at build time.
- **Hot Module Replacement (HMR):** Implement a custom HMR development server. This will allow for live code changes in systems without requiring a full application restart, speeding up development and debugging.
- **Improved API Design:** The transpiler unlocks the ability to design a cleaner, less boilerplate-heavy API for systems.
- **Method Overload:** Single method name can handle different kinds of inputs to perform a similar action. This reduces cognitive load as there is no longer a need to remember multiple function names for slight variations of the same task.
- **Code Generation, inline function calls** - could be something we can use too, aha.

### 3. Parallelism & Multi-threading

With a unified data model and a transpiler in place, the engine will be ready for a true multi-threaded job system.

- **Job System with Explicit Dependencies:** Systems will declare their data dependencies (read/write access to component types).

- **Dependency Graph & Scheduling:** The engine will build a dependency graph from these declarations each frame. A scheduler will use this graph to find non-conflicting systems and dispatch them to a pool of Web Workers for parallel execution.
- **Zero-Copy Data Transfer:** All component data will be stored in `SharedArrayBuffer`s, allowing the main thread and worker threads to access the same memory without any copying overhead.

- **Chunk-Based Work Distribution:** Chunk-based iteration model will be the foundation for work distribution. The scheduler will assign different chunks of an archetype to different workers.

### 4. Renderer

- **Resist:** - Resist the urge to mess around with our own renderer engine... at least until the rest of the engine is somewhat built.
