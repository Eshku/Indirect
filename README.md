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

**Current state** - **Technically usable** and **very messy** single threaded ECS with basic functionality and lots of bad practices in place.

**Next significant steps:**

- Introduce dynamic (packed) arrays, stored on chunk (?).
- Figure something out about processors, schemas and all that. Current situation leads to ever increasing entity creation overhead as more data types are introduced.
- Low-level system - command buffer interactions (ComponentTypeId's)
- Low-level command buffer
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

Components are defined with a `static schema` that dictates how their data is stored and accessed. Complex data stored as numeric references to objects managed elsewhere.

**Schema Types:**

- **Primitive Types:** For simple numeric properties. These are the most common and performant types, directly mapping to `TypedArray`s.

  - **Definition:** Can be defined explicitly (e.g., `{ type: 'f64' }`) or using a shorthand (e.g., `'f64'`).
  - **Supported Types:** `f64` (Float64Array), `f32` (Float32Array), `i32` (Int32Array), `u32` (Uint32Array), `i16` (Int16Array), `u16` (Uint16Array), `i8` (Int8Array), `u8` (Uint8Array). `boolean` is an alias for `u8`.
  - **Usage Note:** Choosing smallest appropriate data type is crucial for performance due to CPU cache lines and SIMD optimizations.

- **Interned Strings:** For string data engine stores a single copy of the string and uses an integer reference (`u32`) to it.

  - **Definition:** `{ type: 'string' }` or shorthand `'string'`.

- **Enums:** For properties that can only be one of a set of mutually exclusive string values.

  - **Definition:** `{ type: 'enum', of: ['STATE_A', 'STATE_B', 'STATE_C'] }`.
  - Underlying storage type (`u8`, `u16`, `u32`) is automatically inferred based on the number of options. A static lookup object (e.g., `ComponentClass.STATE`) is attached to component class for readable comparisons.

- **Bitmasks:** For properties that can have multiple states simultaneously (e.g., status effects).

  - **Definition:** `{ type: 'bitmask', of: ['FLAG_A', 'FLAG_B', 'FLAG_C'] }`.
  - Underlying storage type (`u8`, `u16`, `u32`) is automatically inferred. Supports up to 32 flags. A static lookup object (e.g., `ComponentClass.FLAGS`) is attached for bitwise operations.

- **Array Types:**

  - **`flat_array`**: For fixed-size collections of simple data.
    - **Definition:** `{ type: 'flat_array', of: 'u32', capacity: 10 }`.
    - Flattens array into individual properties (e.g., `myArray0`, `myArray1`, ..., `myArray9`) within component's `TypedArray`s. An implicit `_count` property (e.g., `myArray_count`) is also created to track number of elements used.
      \*\*`dynamic_array`: ...not yet implemented (packed arrays).

- **Tag Components:** A special type of component that contains no data. It serves only as a marker for queries (e.g., `PlayerTag`, `EnemyTag`). Defined as a class with no `static schema` or instance properties.

- **RPN (Reverse Polish Notation) Formulas:** For complex, dynamic calculations.
  - **Definition:** `{ type: 'rpn', streamDataType: 'f32', streamCapacity: 100, instanceCapacity: 10 }`.
  - Internally uses `flat_array` to store RPN instruction stream and additional `flat_array`s for formula start and length metadata.

### [Queries](app/client/Managers/QueryManager/Query.js)

Queries are used by Systems to find and iterate over entities that possess a specific set of components. They are defined using a combination of component requirements.

**Query Criteria:**

When creating a query using `queryManager.getQuery()`, specify component requirements using following parameters:

- **`with`**: An array of component classes that _must_ be present on an entity for it to match the query.
- **`without`**: An array of component classes that _must not_ be present on an entity for it to match the query.
- **`any`**: An array of component classes where at least one of them _must_ be present on an entity for it to match query.
- **`react`**: An array of component classes. Entities matching the query will only be yielded if one of these components has changed since last query iteration. These components are also implicitly required (`with`).

Queries use bitwise operations on archetype masks to determine which archetypes contain required components and exclude forbidden ones.

**Query Iteration Methods:**

Primary way to iterate over entities matching a query is through `query.iter()` method. This method yields `Chunk` objects, allowing systems to process data in cache-friendly blocks.

- **Normal Iteration**: When no `react` components are specified, `query.iter()` yields all `Chunk`s from archetypes that structurally match query. Systems then iterate over entities within these `Chunk`s.
- **Reactive Iteration**: If `react` components are specified, `query.iter()` only yields `Chunk`s from archetypes where one of `react` components has been modified since query's last iteration. This allows systems to react only to relevant changes, reducing processing overhead. Within a system, `query.hasChanged(chunk, indexInChunk)` can be used to check if a specific entity's reactive components have changed.

### System Loop

Systems are classes that encapsulate game logic. They operate on entities that possess a specific set of components, processing their data each frame. Core logic of a system resides within its `update` method.

`Update` method receives `deltaTime` (time elapsed since last frame) and `currentTick`. Within this method, systems typically iterate over entities that match their defined queries.

```javascript
export class MovementSystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [Position, Velocity, Speed, MovementIntent, PhysicsState],
		})

		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.speedTypeID = componentManager.getComponentTypeID(Speed)
		this.intentTypeID = componentManager.getComponentTypeID(MovementIntent)

		// Create reusable markers to avoid allocations in the update loop.
		this.positionDirtyMarker = new DirtyMarker()
		this.velocityDirtyMarker = new DirtyMarker()
	}

	update(deltaTime, currentTick) {
		// Cache the markers in local variables for a minor performance boost inside the loop.
		const positionMarker = this.positionDirtyMarker
		const velocityMarker = this.velocityDirtyMarker

		for (const chunk of this.query.iter()) {
			const archetype = chunk.archetype

			//  Direct Data Access: Get raw TypedArrays once per chunk
			const positionArrays = archetype.componentArrays[this.positionTypeID]
			const velocityArrays = archetype.componentArrays[this.velocityTypeID]
			const intentArrays = archetype.componentArrays[this.intentTypeID]
			const speedArrays = archetype.componentArrays[this.speedTypeID]

			// Initialize the markers once per chunk.
			const positionMarker = archetype.getDirtyMarker(archetype.id, this.positionTypeID, currentTick)
			const velocityMarker = archetype.getDirtyMarker(archetype.id, this.velocityTypeID, currentTick)

			for (const entityIndex of chunk) {
				// Set velocity based on intent and speed.

				velocityArrays.x[entityIndex] = intentArrays.desiredX[entityIndex] * speedArrays.value[entityIndex]

				// Update position based on velocity.
				positionArrays.x[entityIndex] += velocityArrays.x[entityIndex] * deltaTime
				positionArrays.y[entityIndex] += velocityArrays.y[entityIndex] * deltaTime

				// Mark components dirty, so reactive queries can react to changes.
				positionMarker.mark(entityIndex)
				velocityMarker.mark(entityIndex)
			}
		}
	}
}
```

In the example above, `MovementSystem` defines a query to select entities with `Position`, `Velocity`, `Speed`, `MovementIntent`, and `PhysicsState` components.

`Update` method iterates through `chunks` yielded by query. For each chunk, it directly accesses underlying `TypedArray`s for relevant component properties (e.g., `positionArrays.x`, `velocityArrays.y`).

After modifying component data, `DirtyMarker`s are used to mark components as changed. This mechanism allows reactive queries to efficiently identify and process only those entities whose relevant components have been updated since last frame.

### Working with Enums and Bitmasks

Engine provides native support for defining and working with enumerations and bitmasks directly within component schemas. This allows for efficient storage and manipulation of state and flags using `TypedArray`s and bitwise operations.

This approach works with raw integer values stored in `TypedArray`s, using bitwise logic for bitmasks and integer comparisons for enums.

`SchemaParser` helps by attaching static lookup objects (`.FLAGS` for bitmasks, `.STATE` for enums in this case) to component classes, making raw values readable in code.

```javascript
export class CombatSystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [WeaponState, StatusEffects, WeaponDamageType],
		})

		this.weaponStateTypeID = componentManager.getComponentTypeID(WeaponState)
		this.statusEffectsTypeID = componentManager.getComponentTypeID(StatusEffects)
		this.weaponDamageTypeID = componentManager.getComponentTypeID(WeaponDamageType)
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const archetype = chunk.archetype

			//  Get direct references to the underlying TypedArrays
			const weaponStateArrays = archetype.componentArrays[this.weaponStateTypeID]
			const statusEffectsArrays = archetype.componentArrays[this.statusEffectsTypeID]
			const damageTypeArrays = archetype.componentArrays[this.weaponDamageTypeID]

			for (const entityIndex of chunk) {
				// Read raw integer values directly from the TypedArrays.
				const currentState = weaponStateArrays.state[entityIndex]
				const currentFlags = statusEffectsArrays.flags[entityIndex]

				// Use static lookup objects for readable comparisons and bitwise operations.
				const isStunned = (currentFlags & StatusEffects.FLAGS.STUNNED) !== 0

				if (currentState === WeaponState.STATE.IDLE && !isStunned) {
					console.log(`Entity ${entityIndex} is attacking!`)
					// Write new raw integer value for enum.
					weaponStateArrays.state[entityIndex] = WeaponState.STATE.ATTACKING

					const isBurning = (currentFlags & StatusEffects.FLAGS.BURNING) !== 0
					if (isBurning) {
						const damageTypes = damageTypeArrays.types[entityIndex]
						const hasWaterDamage = (damageTypes & WeaponDamageType.TYPES.WATER) !== 0

						if (hasWaterDamage) {
							console.log(`Entity ${entityIndex}'s water attack doused the fire!`)
							// Use bitwise AND NOT to clear 'BURNING' flag.
							statusEffectsArrays.flags[entityIndex] &= ~StatusEffects.FLAGS.BURNING
						}
					}
				}
			}
		}
	}
}
```

### Command Buffer: Safe and Efficient Structural Changes

The Command Buffer is a crucial mechanism for safely managing structural changes to the ECS world. Modifying the world's structure (e.g., adding/removing components, creating/destroying entities) while systems are iterating over it is unsafe and can lead to crashes or corrupted data. The command buffer solves this by recording all such changes and executing them at a safe point at the end of the frame.

While the primary goal is safety, the command buffer is also designed for high performance through several key features:

1.  **Automatic Sorting**: Commands are not executed in the order they are recorded. Instead, they are automatically sorted to ensure a logical and safe sequence: all destructions happen first, then all modifications (adding/removing components), and finally all creations. This prevents errors like trying to modify an entity that has already been destroyed in the same frame. Order can be influenced by using a `layer` parameter in most command functions for more advanced control.

2.  **Command Consolidation**: If a command recorded to add a component and later record a command to remove it from the same entity within the same frame, the buffer cancels them out. Similarly, creating and then immediately destroying an entity results in no work being done. This reduces unnecessary operations.

3.  **Batched Operations**: To maximize performance, buffer groups similar operations together. Instead of moving entities between archetypes one by one, it identifies all entities that need the same structural change and moves them all at once in a large, cache-friendly batch. The same principle applies to creating and destroying entities.

#### API and Examples

Systems receive a `commands` object, which is an instance of `CommandBuffer`.

**Basic Commands**

To interact with the buffer, `componentTypeID` used for the components to be modified.

```javascript
// In a system's constructor or init method:
this.positionTypeID = componentManager.getComponentTypeID(Position)
this.healthTypeID = componentManager.getComponentTypeID(Health)

// In the update loop:
const newPlayer = this.commands.createEntity(
	new Map([
		[this.positionTypeID, { x: 100, y: 200 }],
		[this.healthTypeID, { value: 100 }],
	])
)

this.commands.addComponent(someEntity, this.healthTypeID, { value: 50 })

this.commands.removeComponent(anotherEntity, this.positionTypeID)

this.commands.destroyEntity(enemyEntity)
```

**Maps are subject to change.**

**Instantiating Prefabs**

Instantiating from a prefab is a common operation. Command buffer has a dedicated method for it.

```javascript
// In the update loop of a weapon system
if (fireButtonPressed) {
	const overrides = new Map([
		[this.positionTypeID, { x: this.muzzlePoint.x, y: this.muzzlePoint.y }],
		[this.velocityTypeID, { x: 1000, y: 0 }],
	])
	this.commands.instantiate('fireball_projectile', overrides)
}
```

**Query-based Batch Operations**

The `CommandBuffer` provides high-level helper methods to apply changes to all entities matching a query.

```javascript
// In a system that applies a "burning" effect
const burningQuery = queryManager.getQuery({ with: [Flammable], without: [BurningEffect] })

// ... some logic to determine if the area is on fire ...
if (areaIsOnFire) {
	// Add the BurningEffect component to all flammable entities that aren't already burning.
	this.commands.addComponentToQuery(burningQuery, this.burningEffectTypeID, { duration: 5, damagePerSecond: 10 })
}
```

### Prefab Definitions: Manifest-Driven Approach

Engine uses **manifest-driven** approach for defining and creating entities. Instead of referencing file paths directly - it is using human-readable string called a `prefabId` (e.g., `"obsidian_sword"`, `"player_character"`).

This design decouples game logic from file system structure, making project easier to maintain, and opens the door for future easy modding and powerful developer console commands (`spawn obsidian_sword`).

#### The Prefab Manifest

Core of this system is the [app/client/Data/prefabs.manifest.json](./app/client/Data/prefabs.manifest.json) file. This file acts as a central registry for all entities in the game. It maps each `prefabId` to its source, which can be either a data file (`.json`) or a programmatic factory (`.js` module and function).

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

Prefabs are defined in `.json` files. Supports inheritance using `extends` key, which points to another `prefabId`.

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
