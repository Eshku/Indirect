# Plan: A Safe and Performant Immediate Mode API

This document outlines the architectural plan for a robust immediate-mode API, addressing the current implementation's thread-safety flaws.

---

## 1. The Problem: The "Immediate" Race Condition

The current `ECS.js` API attempts to provide true, synchronous "immediate-mode" operations (e.g., `ecs.createEntity()`, `ecs.destroyEntity()`) that modify the world state directly while the `GameLoop` is running.

This is fundamentally unsafe in our parallel architecture. A call to `ecs.destroyEntity()` on the main thread can deallocate memory that a worker thread is simultaneously trying to read, leading to data corruption, memory access errors, and unpredictable crashes.

A robust API must distinguish between the different needs for "immediacy".

## 2. The Two Types of "Immediate"

The term "immediate" is overloaded. We must support two distinct use cases with two different mechanisms:

1.  **Runtime Immediate (e.g., UI Events):** A user clicks a button, and a visual effect needs to appear *in the same render frame*. The operation feels immediate to the user, but it does not need to be a synchronous, blocking "stop-the-world" event.

2.  **Debug Immediate (e.g., Console Commands):** A developer has **paused the game** and wants to synchronously inspect or modify the world state *right now* to debug an issue. In this context, the world is static.

## 3. The Proposed Architecture

We will refactor the `ECS.js` API to safely support both use cases.

### a. Runtime API: Defer to Command Buffer (Default)

For all standard, runtime interactions, the `ECS.js` API will be changed to **defer operations to the global command buffer**. It will no longer modify the `EntityManager` directly.

**Implementation:**

-   `ecs.createEntity(data)` will be refactored to call `this.instantiate(payload)`.
-   `ecs.addComponent(entity, ...)` will be refactored to call `this.addComponent(entity, ...)`.
-   `ecs.destroyEntity(entity)` will be refactored to call `this.destroyEntity(entity)`.

**Benefits:**

-   **Thread-Safety:** This is perfectly thread-safe. Commands are simply recorded and will be executed in the correct, serialized order by the `CommandBufferExecutor` at the next flush point.
-   **Performance:** It leverages the highly optimized, batched execution paths of the command buffer.
-   **User Experience:** For UI events, the change will typically be processed and rendered in the very next visual frame, which is "immediate enough" to feel responsive.

### b. Debug API: Require a Paused World

For true, synchronous, stop-the-world modification, we will introduce a new, explicit API that only functions when the game is paused.

**Implementation:**

1.  **New API Namespace:** A new API, `ecs.debug`, will be created.

2.  **Pause Check:** Every method within `ecs.debug` will begin with a check:

    if (!this.systemManager.gameLoop.isPaused) {
        throw new Error('Debug API methods can only be called when the GameLoop is paused.');
    }

3.  **Direct, Non-Atomic Modification:** If the loop is paused, we have a guarantee that no worker threads are running and no systems are executing. It is now safe to perform direct, **non-atomic** modifications to the `EntityManager`'s data.

    // Example
    ecs.debug.setComponentNow(entityId, 'position', { x: 100 });

4.  **No Version Bumping:** These debug operations should **not** increment the `globalVersion`. They are out-of-band changes to a static world state. When the game is resumed, systems will simply see the new state as it is.

## 4. Summary of Changes

| Operation                                | Current (Unsafe) Behavior                               | Proposed (Safe) Behavior                                                                 |
| ---------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ecs.createEntity()`                     | Directly modifies `EntityManager`, increments version.  | Records an `instantiate` command in the `EntityCommandBuffer`.                           |
| `ecs.addComponent()`                     | Directly modifies `EntityManager`, increments version.  | Records an `addComponent` command in the `EntityCommandBuffer`.                          |
| `ecs.destroyEntity()`                    | Directly modifies `EntityManager`.                      | Records a `destroyEntity` command in the `EntityCommandBuffer`.                          |
| `ecs.debug.setComponentNow()` (New)      | N/A                                                     | If paused, directly writes to component data. If running, throws error.                  |
| `ecs.debug.teleportEntityNow()` (New)    | N/A                                                     | If paused, directly writes to `position` component. If running, throws error.            |

## 5. Conclusion

This two-pronged approach provides a safe, predictable, and performant API for all use cases.

-   **Developers** get a simple, deferred API (`ecs.*`) that "just works" for runtime events without introducing race conditions.
-   **Debuggers** get a powerful, explicit API (`ecs.debug.*`) for synchronous modification, with a clear safety contract that it only works on a paused world.

This resolves the architectural flaws in the current immediate-mode implementation and provides a robust foundation for future development.