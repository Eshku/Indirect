# JavaScript Hybrid ECS Electron Game Engine Thing

## Introduction

**Set expectation low.**

This is result of messing around with game dev with very little experience in the sphere, especially on ECS part.
Wobbly foundation of what could be an engine, expect bugs and unfinished features, alot of things are not tested and constantly changing.

Readme might be outdated.

**Current state** - **Technically usable** and **very messy** single threaded ECS with basic functionality and lots of bad practices in place.

**Next significant steps:**

- Drop cold-data completely, only typed arrays for components. AoS support was a mistake.
- High-level API and support for more data types - interned strings (but not bytes, another mistake), asset access by pointer, audio and whatnot.
- compiler \ transpiler to inline slow high-level API calls to win performance back (views are approximatly ~25x slower inside of per-entity loops, according to some limited benchmarks)
- Parrallelism.
- Custom HMR, or in simple terms - hot reload.
- Serialization \ Deserialization.
- Stop reading prefabs in systems, Technically viable strategy, but very inefficient. Gonna provide better way to store and access shared prefab data.
- Steps above would require alot of changes in core archetechture, so code quality most likely will get only worse until we are done with those steps.

## Tech Stack

- **Electron** - Main application framework.
- **Pixi.js** - 2D rendering engine, but could be changed to any other rendeding engine, we are using our own update loops loops.
- **Planck.js** - 2D physics engine. It there, but it is not yet used ¯\_(ツ)\_/¯
- **Vanila Javascript** - Yes.

## Architecture

Built on a set of common design patterns.

### The Core: Entity-Component-System (ECS) Hybrid

- **Entity**: Unique number (an ID) that represents a game object.
- **Component**: A class that acts as a **schema** for a piece of data. This blueprint determines how to store the data.
- **Archetype**: All entities with the exact same set of components are stored together in the same archetype.
- **System**: Container for logic. Systems operate on entities that have a specific set of components.
- **Managers** - Engine-level functionality, act as resources or APIs.
- **Service** - Glorified set of on-demand utilities.

#### Archetypes: The Core Data Containers

An **Archetype** is the core data structure that stores all entities sharing the exact same set of components.

- **Data Storage:** Within an archetype, all data is stored in arrays.

  - An array of entity IDs (`Uint32Array`).
  - For "Hot" components (SoA), each property becomes its own `TypedArray` (e.g., `position.x` values are in one array, `position.y` values in another).
  - For "Cold" components (AoS), instances are stored as objects in a standard JavaScript `Array`.
  - A `dirtyTicksArray` is stored alongside each component's data to track when it was last modified, enabling reactive systems.

- **Immortal Archetypes:** Archetype _definitions_ are "immortal". Once created, they are never destroyed, even if they contain no entities. This is a performance optimization that avoids "archetype churn"- expensive process of repeatedly creating and destroying archetypes, which would force the `QueryManager` to constantly re-evaluate all active queries. This trades a small amount of memory for a gain in structural change performance.

#### Chunks: The Unit of Iteration (and Parallelism)

Each archetype's data is divided into fixed-size **Chunks** , each of which is a view into a segment of an archetype's data arrays.

## Key Features & Design Patterns

### Hot vs. Cold Data (SoA vs. AoS)

Explicit separation of component data into "hot" and "cold" storage, which can be configured directly on the component class.

- **Hot Components (Struct-of-Arrays):** For frequently accessed data (e.g., `Position`, `Velocity`).

  - **How:** Define a `static schema` on the component class (e.g., `static schema = { x: 'f64', y: 'f64' }`).
  - **Storage:** The engine automatically stores this data in `TypedArray`s, one for each property. This is the cache-friendly **Struct-of-Arrays (SoA)** layout.
  - **Why:** Improves CPU cache efficiency and enables potential auto-vectorization (SIMD) by JavaScript engine.

- **Cold Components (Array-of-Structs):** For complex, non-primitive, or less frequently accessed data.

  - **How:** Just **omit** the `static schema`.
  - **Storage:** All instances of the component are stored as complete objects in a single JavaScript `Array` (e.g., `[comp1, comp2, ...]`). This is the traditional **Array-of-Structs (AoS)** layout.
  - **Why:** Provides flexibility for complex data structures (`Map`, references to other library objects, etc.) where the performance overhead is acceptable.
  - **Note:** AoS is a lie, there is no guarantie objects are stored in a continious memory, this is effectively array of pointers.

- **Tag Components:** A special type of "hot" component that contains no data. It is defined as a schemaless class with no instance properties. It serves only as a marker for queries (e.g., `PlayerTag`).

### Data Access: Schemas, Views, and Accessors

Component classes (e.g., `Position`) are not the components themselves, but **schemas**. When a component is added to an entity, the `ComponentManager` and `SchemaParser` analyze its definition to determine the most efficient way to store its data.

This section explains how to define component data structures and how the engine provides a high-performance API to access them.

**1. Choosing the Right Schema Type**

The schema type you choose for a component property determines how it's stored and accessed. Schema affects both memory usage and performance.

**2. Component Schema Examples**

Declare the structure of a "hot" component using a `static schema`. This tells the engine how to lay out the data in memory using efficient `TypedArray`s.

_Simple Primitive Schema:_

```javascript
export class Position {
	static schema = {
		x: 'f64',
		y: 'f64',
	}

	constructor({ x = 0, y = 0 } = {}) {
		this.x = x
		this.y = y
	}
}
```

_Shared String Schema:_
For string data engine interns these strings.

```javascript
export class Prefab {
	static schema = {
		id: {
			type: 'string',
		},
	}

	constructor({ id = '' } = {}) {
		this.id = id
	}
}
```

_Enum Schema:_
For a property that can only be in one of several mutually exclusive states.

```javascript
export class WeaponState {
	static schema = {
		state: {
			type: 'enum',
			of: 'u8', // Stored as an integer (0, 1, 2...)
			values: ['IDLE', 'ATTACKING', 'RELOADING'],
		},
	}
	// The parser will create WeaponState.STATE = { IDLE: 0, ... } for easy access.

	constructor({ state = 'IDLE' } = {}) {
		this.state = state
	}
}
```

_Bitmask Schema:_
For a property that can have multiple flags set at once.

```javascript
export class StatusEffects {
	static schema = {
		flags: {
			type: 'bitmask',
			of: 'u8', // Stored as a single integer bitfield.
			values: ['POISONED', 'STUNNED', 'BURNING'],
		},
	}
	// The parser will create StatusEffects.FLAGS = { POISONED: 1, STUNNED: 2, BURNING: 4, ... }

	constructor({ flags = 0 } = {}) {
		this.flags = flags
	}
}
```

_Complex Schema with Flattened Array:_

```javascript
export class Hotbar {
	static schema = {
		slots: {
			type: 'array',
			of: 'u32', // Type of elements in the array
			capacity: 10,
		},
		activeSlotIndex: 'u8',
	}

	constructor({ slots = [], activeSlotIndex = 0 } = {}) {
		this.slots = slots
		this.activeSlotIndex = activeSlotIndex
	}
}
```

### Queries

Systems access entity data through **Queries**. A query defines a "shape" of an entity that a system is interested in.

```javascript
this.query = queryManager.getQuery({
	with: [], // Must have these components
	without: [], // Must NOT have this component
	any: [], // Must have at least one of these
	react: [], // Only process entities whose Position has changed
})
```

Queries are mutable - each system has own query or multiple queries, which can be changed at runtime.

```javascript
this.query.setCriteria({
	with: [Position],
	without: [Velocity],
})
```

**Query iteration methods:**

- **`query.iter()`:** The main way to loop. It iterates over matching archetypes, not individual entities.
- **`query.hasChanged(archetype, entityIndex)`:** An explicit check for reactive queries to see if a specific entity's monitored components has changed since the system last ran.

### System Loop:

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
			const positionMarker = archetypeManager.getDirtyMarker(archetype.id, this.positionTypeID, currentTick)
			const velocityMarker = archetypeManager.getDirtyMarker(archetype.id, this.velocityTypeID, currentTick)

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

### Working with Enums and Bitmasks

This approach works with the raw integer values stored in the `TypedArray`s, using bitwise logic for bitmasks and integer comparisons for enums.

The `SchemaParser` helps by attaching static lookup objects (`.FLAGS` for bitmasks, `.STATE` for enums in this case) to the component classes, making the raw values readable in code.

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

			//  The Fast Path: Get direct references to the underlying TypedArrays
			const weaponStateArrays = archetype.componentArrays[this.weaponStateTypeID]
			const statusEffectsArrays = archetype.componentArrays[this.statusEffectsTypeID]
			const damageTypeArrays = archetype.componentArrays[this.weaponDamageTypeID]

			for (const entityIndex of chunk) {
				// Read the raw integer values directly from the TypedArrays.
				const currentState = weaponStateArrays.state[entityIndex]
				const currentFlags = statusEffectsArrays.flags[entityIndex]

				// Use the static lookup objects for readable comparisons and bitwise operations.
				const isStunned = (currentFlags & StatusEffects.FLAGS.STUNNED) !== 0

				if (currentState === WeaponState.STATE.IDLE && !isStunned) {
					console.log(`Entity ${entityIndex} is attacking!`)
					// Write the new raw integer value for the enum.
					weaponStateArrays.state[entityIndex] = WeaponState.STATE.ATTACKING

					const isBurning = (currentFlags & StatusEffects.FLAGS.BURNING) !== 0
					if (isBurning) {
						const damageTypes = damageTypeArrays.types[entityIndex]
						const hasWaterDamage = (damageTypes & WeaponDamageType.TYPES.WATER) !== 0

						if (hasWaterDamage) {
							console.log(`Entity ${entityIndex}'s water attack doused the fire!`)
							// Use bitwise AND NOT to clear the 'BURNING' flag.
							statusEffectsArrays.flags[entityIndex] &= ~StatusEffects.FLAGS.BURNING
						}
					}
				}
			}
		}
	}
}
```

### Command Buffer: Deferring Structural Changes

Modifying the structure of the ECS world while systems are iterating over it is unsafe. Adding or removing components changes an entity's archetype, which can invalidate the very data structures a system is currently looping through.

The **Command Buffer** solves this problem by providing a mechanism to defer all structural changes.

**Key Features of the Flush Process:**

The `commandBuffer.flush()` method to apply changes deffered to the end of a frame:

1.  **Consolidation:** Before executing anything, the buffer consolidates all commands. For example, if an entity is created and then destroyed in the same frame, the commands cancel each other out, and no work is done. If a component is added and then removed, nothing happens.
2.  **Batched Operations:** The buffer groups all structural changes (like adding/removing components, which cause archetype moves) by their source and target archetypes. It then moves entities in large, cache-friendly batches, which is significantly faster than moving them one by one.
3.  **Updates:** Simple data updates that don't change an entity's archetype are handled separately using in-place update mechanism.

#### Example Usage

A `CollisionSystem` might queue a `destroyEntity` command when two entities collide.

```javascript
export class CollisionSystem {
	// ... query for collidable entities ...

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			// ... collision detection logic to find entityA and entityB ...
			if (isColliding(entityA, entityB)) {
				// Don't destroy immediately. Queue the command instead.
				this.commands.destroyEntity(entityB)
			}
		}
	}
}
```

### Prefab Definitions: The Manifest-Driven Approach

The engine uses **manifest-driven** approach for defining and creating entities. Instead of referencing file paths directly - it is using human-readable string called a `prefabId` (e.g., `"obsidian_sword"`, `"player_character"`).

This design decouples game logic from the file system structure, making the project easier to maintain, and opens the door for future easy modding and powerful developer console commands (`spawn obsidian_sword`).

#### The Prefab Manifest

The core of this system is the `modules/Data/prefabs.manifest.json` file. This file acts as a central registry for all entities in the game. It maps each `prefabId` to its source, which can be either a data file (`.json`) or a programmatic factory (`.js` module and function).

**Example `prefabs.manifest.json`:**

```json
{
	"player_character": {
		"module": "modules/Data/Prefabs/Playable/Player.js"
	},
	"fireball": {
		"path": "modules/Data/Prefabs/Items/Skills/Fireball.json"
	},
	"item_base": {
		"path": "modules/Data/Prefabs/Items/Item.json"
	}
}
```

**Manifests will be automatically generated later on.**

#### Data-Driven Prefabs

Prefabs are defined in `.json` files. Supports inheritance using the `extends` key, which points to another `prefabId`.

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

### The Async Game Loop & System Update Phases

The engine's `GameLoop` is a custom `async` loop built around `requestAnimationFrame`.

#### The Async Game Loop

The primary benefit of the `async` loop is the ability to `await system.update(...)`. This ensures that any asynchronous operations within a system (like on-demand asset loading) complete fully before the next system runs.

- **Predictable Execution Flow**: By `await`ing every system by default, the execution flow is sequential and easy to reason about. A system can rely on the fact that all previous systems in the frame have completed their work.
- **"Fire-and-Forget" as an Option**: While `await` is the default, this architecture still supports non-blocking, "fire-and-forget" async operations. A system can launch an async task (e.g., a network request) without `await`ing it, allowing the game loop to continue immediately.
- **Prep for Parallelism**: This design provides foundation for integrating Web Workers. Main loop can `await` a message from a worker.

#### System Update Phases

System scheduling is defined by the `frequency` property of each system in `modules/Managers/SystemManager/systemConfig.js`. This file is the single source of truth for execution order and update frequency. The main frequencies are:

- **`'none'`**: For systems that only need to be initialized. Their constructor and `init()` method are called, but they are never added to any update loop. Ideal for purely event-driven systems (e.g., setting up listeners for external libraries).

- **`Input`:**

  - **When:** Runs first in the frame, once per `requestAnimationFrame` call.
  - **Use For:** The lowest-latency input processing. Ideal for systems that need to react to user actions before any other logic, such as updating a custom mouse cursor's position.

- **`Logic`:**

  - **When:** Runs on a deterministic, fixed timestep (e.g., 60 times per second), independent of the rendering frame rate. The loop may run multiple times per frame to catch up, or zero times if the frame is too fast.
  - **Use For:** Physics, core gameplay logic, and anything requiring deterministic, reproducible behavior. This ensures the game simulation is consistent across different machines and frame rates. This entire phase is a candidate for future parallel execution on a Web Worker.

- **`Timed Groups`:**

  - **When:** Runs on a timer at the specified updates-per-second, after the `Logic` phase but before the `Visuals` phase.
  - **Use For:** Infrequent logic that doesn't need to run every frame, such as certain UI updates, AI decision-making, or performance monitoring. This is a powerful optimization tool to reduce CPU load without complicating system code with internal timers.

- **`Visuals`:**

  - **When:** Runs once per visual frame, after all `Logic` and timed updates for that frame are complete. The `deltaTime` can vary.
  - **Use For:** Rendering, visual effects, interpolation between fixed updates (`alpha`), UI updates, and camera movement. This is for logic that needs to be as smooth as the display's refresh rate allows.

  **Update Group names are subject to change.**

### Debugging & Immediate-Mode API: The `ECS` Object

For debugging, testing, and performing one-off actions outside of systems, the engine exposes a global `ECS` object. This object provides a high-level, immediate-mode API for interacting with the world.

**Important:** This API is for convenience and should **not** be used inside performance-critical systems. For structural changes within a system's `update` loop, always use the deferred `commands` object.

#### Inspecting Entities

To inspect an entity's state from the developer console, use `ECS.getEntity(entityID)`. This returns `Entity` wrapper object.

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

The `ECS` object also provides methods to modify the world state immediately. This is useful for setting up scenes, responding to UI events, or using console commands.

```javascript
// Create a new entity with components
const newEntityId = ECS.createEntity({
	Position: { x: 10, y: 20 },
	Velocity: { x: 5, y: 0 },
})

// Add a component to an existing entity.
// Note: You need a reference to the actual Component Class (e.g., Health), not a string.
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

## Roadmap & Future Directions

The engine's future development is focused on three interconnected pillars. Many improvements in one area are prerequisites for advancements in others.

### 1. ECS Core Improvements

This involves strengthening the fundamental architecture of the Entity-Component-System for greater performance, flexibility, and robustness.

- **Unified "Hot-Only" Data Model:** The highest priority is to complete the transition to a 100% "hot" data architecture, every component should only store data in typed arrays.
- **Relational ECS Patterns:** Explore and implement more advanced ECS patterns, like entity hierarchies (`Parent`/`Children` components) and relational queries.
- **Serialization:** Develop a robust system for serializing and deserializing.
- **Code Quality & Decoupling:** As the foundation stabilizes, refactor the manager-based architecture to reduce tight coupling and improve overall code quality and documentation.

### 2. Transpiler & Developer Experience

A build-time transpiler is the cornerstone for achieving both a high-quality developer experience and maximum runtime performance.

- **Goal: Zero-Cost Abstractions:** The primary goal is to allow developers to write clean, intuitive, object-oriented code using accessors and views, and have the transpiler automatically rewrite it into low-level "fast path" code (direct `TypedArray` access) at build time.
- **Hot Module Replacement (HMR):** Implement a custom HMR development server. This will allow for live code changes in systems without requiring a full application restart, dramatically speeding up development and debugging.
- **Improved API Design:** The transpiler unlocks the ability to design a cleaner, less boilerplate-heavy API for systems.
- **Method Overload:** Single method name can handle different kinds of inputs to perform a similar action. This reduces cognitive load as there is no longer a need to remember multiple function names for slight variations of the same task.

### 3. Parallelism & Multi-threading

With a unified data model and a transpiler in place, the engine will be ready for a true multi-threaded job system.

- **Job System with Explicit Dependencies:** Systems will declare their data dependencies (read/write access to component types).
- **Dependency Graph & Scheduling:** The engine will build a dependency graph from these declarations each frame. A scheduler will use this graph to find non-conflicting systems and dispatch them to a pool of Web Workers for parallel execution.
- **Zero-Copy Data Transfer:** All component data will be stored in `SharedArrayBuffer`s, allowing the main thread and worker threads to access the same memory without any copying overhead.
- **Chunk-Based Work Distribution:** Chunk-based iteration model will be the foundation for work distribution. The scheduler will assign different chunks of an archetype to different workers.
