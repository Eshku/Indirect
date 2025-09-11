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
- Figure something out about processors, schemas and all that. Current situation leads to ever increasing entity creation overhead as more data types are introduced.
- Generational Entity IDs
- Parrallelism.
- Custom HMR, or in simple terms - hot reload.
- Serialization \ Deserialization.
- React on component addition \ changes as 2 separate things (?)
- indirect everything 👀

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

#### Archetypes: Defining Entity Structures

**Archetype** defines a unique combination of components. Each Archetype manages a collection of data containers - **Chunks**.

- **Immortal Archetypes:** Archetype _definitions_ are "immortal". Once created, they are never destroyed, even if they contain no entities. This is a performance optimization that avoids "archetype churn"- expensive process of repeatedly creating and destroying archetypes, which would force `QueryManager` to constantly re-evaluate all active queries. This trades a small amount of memory for a gain in structural change performance.

#### [Chunks](app/client/Managers/ArchetypeManager/Chunk.js): Unit of Iteration (and Parallelism)

Each archetype's data is organized into fixed-size **Chunks**. A Chunk is a contiguous block of memory that directly stores entities and their associated component data in a Structure of Arrays (SoA) layout.

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

_Example `Position.js` component:_

```javascript
/**
 * A component that stores an entity's position in 2D space.
 */
export const Position = {
	x: { type: 'f64', default: 0 },
	y: { type: 'f64', default: 0 },
}
```

**Schema Property Definition:**

Every property in a schema must be an object containing a `type` and an optional `default` value.

- **`type`**: A string specifying the data type.
- **`default`**: A default value to use for the property when a component is added without specifying a value. If omitted, a zero-equivalent (0, false, "") is used.
- **`shared`**: A boolean. If `true`, this property's data is shared across all entities that have the same value for it.
- Other keys like `of`, `capacity`, `storageType` are used for more complex types.

**Schema Types:**

- **Primitive Types:** For simple numeric properties. These are the most common and performant types, directly mapping to `TypedArray`s.

  - **Definition:** `{ type: 'f64' }`
  - **Supported Types:** `f64`, `f32`, `i32`, `u32`, `i16`, `u16`, `i8`, `u8`, `boolean`.

- **`string`:** For string data. The engine stores a single copy of each unique string and uses an integer reference (`u32`) to it. This process is called string interning. See [Working with Interned Strings](#working-with-interned-strings) for details on how to read this data.

  - **Definition:** `{ type: 'string' }`
  - All strings are **interned**. This means that each unique string (e.g., "Magic Missile", "Player_Character_Name") is stored only once in a global table, and the component itself stores a lightweight numeric ID (a `u32` reference) pointing to that string.

- **`enum`:** For properties that can only be one of a set of mutually exclusive string values.

  - **Definition:** `{ type: 'enum', of: ['STATE_A', 'STATE_B'] }`.
  - The underlying storage type (`u8`, `u16`, `u32`) is automatically inferred based on the number of options. A static lookup object is generated for readable comparisons.

- **`bitmask`:** For properties that can have multiple states simultaneously.

  - **Definition:** `{ type: 'bitmask', of: ['FLAG_A', 'FLAG_B'], storageType: 'u8' }`.
  - The `storageType` (`u8`, `u16`, `u32`) is automatically inferred if not provided. A static lookup object is generated for bitwise operations.

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

The `update` method iterates through chunks, and for each entity, it performs a cheap `hasChanged()` check before proceeding. If the check passes, it performs the calculation and marks the `Position` component as "dirty," allowing other systems to react to the change.

### Working with Enums and Bitmasks

The engine provides native support for defining and working with enumerations and bitmasks directly within component schemas.

When a schema with an `enum` or `bitmask` is compiled, the `ComponentManager` makes a lookup object available via `componentManager.getConstantsFor('ComponentName')`. This allows for readable code without sacrificing performance.

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
		this.WeaponState = componentManager.getConstantsFor('WeaponState')
		this.StatusEffects = componentManager.getConstantsFor('StatusEffects')
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const weaponStateArrays = chunk.componentArrays[this.weaponStateTypeID]
			const statusEffectsArrays = chunk.componentArrays[this.statusEffectsTypeID]

			for (const entityIndex of chunk) {
				const currentState = weaponStateArrays.state[entityIndex]
				const currentFlags = statusEffectsArrays.flags[entityIndex]

				// Use the cached lookup objects for readable comparisons.
				const isStunned = (currentFlags & this.StatusEffects.FLAGS.STUNNED) !== 0

				if (currentState === this.WeaponState.STATE.IDLE && !isStunned) {
					// Write the new raw integer value for the enum.
					weaponStateArrays.state[entityIndex] = this.WeaponState.STATE.ATTACKING
				}
			}
		}
	}
}
```

### Command Buffer: Safe and Efficient Structural Changes

Command Buffer is a crucial mechanism for safely managing structural changes (adding/removing components, creating/destroying entities). Command buffer solves this by recording all change requests and executing them in a safe, sorted, and consolidated manner at the end of the frame.

#### API and Examples

Systems receive a `commands` object, which is an instance of `CommandBuffer`.

**Basic Commands**

Component Type IDs are used to specify which components to modify.

```javascript
this.commands.createEntity({
	Position: { x: 100, y: 200 },
	Health: { value: 100 },
})

this.commands.addComponent(someEntity, this.healthTypeID, { value: 50 })

this.commands.removeComponent(anotherEntity, this.positionTypeID)

this.commands.destroyEntity(enemyEntity)
```

**Instantiating Prefabs**

Instantiating from a prefab uses the prefab's string name and an optional object of component overrides.

```javascript
// In the update loop

const overrides = {
	Position: { x: this.muzzlePoint.x, y: this.muzzlePoint.y },
	Velocity: { x: 1000, y: 0 },
}
this.commands.instantiate('fireball_projectile', overrides)
```

**Query-based Batch Operations**

The `CommandBuffer` provides helper methods to apply changes to all entities matching a query.

```javascript
// In a system that applies a "burning" effect
const burningQuery = queryManager.getQuery({ with: [Flammable], without: [BurningEffect] })
const { BurningEffect } = componentManager.getTypeIDs()

// ... some logic ...

// Add the BurningEffect component to all flammable entities that aren't already burning.
this.commands.addComponentToQuery(burningQuery, BurningEffect, { duration: 5 })
```

#### Batch Creation with Mutators

For scenarios requiring the creation of many similar entities every frame, the engine provides a high-performance path using the [`PayloadCompiler`](./app/client/Managers/SystemManager/PayloadCompiler.js) that avoids repeated data processing costs.

The workflow is:

1.  **Compile a Payload:** In a system's constructor, define an entity "template" and compile it once into a binary `payload`. This payload also contains `mutators`.
2.  **Mutate:** In the `update` loop, use the `mutators` to efficiently change parts of the binary payload. Mutators are `TypedArray` views that modify the payload's underlying `ArrayBuffer` directly.
3.  **Command:** Pass the updated payload to `commands.createEntities()`.

```javascript
// In a system's constructor:
// 1. Compile the payload once. Initial values don't matter if they will be mutated.
this.projectilePayload = payloadCompiler.compileCreationPayloadFromObject({
	Position: { x: 0, y: 0 },
	Velocity: { vx: 0, vy: 0 },
	Sprite: { texture: 'projectile_sprite' },
})

// In the update loop:

// 2. Get the mutators and the data payload.
const { mutators, ...payload } = this.projectilePayload

// Use mutators to update the binary data with zero allocations.
mutators.Position.x[0] = player.x
mutators.Position.y[0] = player.y
mutators.Velocity.vx[0] = aimVector.x * 1000
mutators.Velocity.vy[0] = aimVector.y * 1000

// 3. Command the creation of one or more entities from the mutated payload.
this.commands.createEntities(payload, 1)
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

To inspect an entity's state from developer console, use `ECS.getEntity(entityID)`. This returns a debug wrapper object for entity.

```javascript
// Get the wrapper for entity with ID 123
const myEntity = ECS.getEntity(123)

// See all components and their data
console.log(myEntity.components)

// Get a specific component instance
const position = myEntity.getComponent('Position')

// Check for a component
if (myEntity.hasComponent('PlayerTag')) {
	// The entity has the PlayerTag component
}
```

#### Immediate-Mode Commands

[ECS](app/client/Core/ECS/ECS.js) object also provides methods to modify the world state immediately.

```javascript
// Create a new entity with components
const newEntityId = ECS.createEntity({
	Position: { x: 10, y: 20 },
	Velocity: { x: 5, y: 0 },
})

// Add a component to an existing entity.

ECS.addComponent(newEntityId, Health, { value: 100 })

// Remove a component
ECS.removeComponent(newEntityId, Velocity)

// Destroy an entity
ECS.destroyEntity(newEntityId)

// Instantiate from a prefab
const sword = ECS.instantiate('obsidian_sword')
```

## Acknowledgements

Architecture heavily inspired by Unity's DOTS, Bevy and data-driven mod-friendly games like Minecraft, Don't Starve.

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
