# ADR-001: Support for Multiple Component Data Layouts

**Status:** Proposed

**Date:** 2023-10-27

## Context and Problem Statement

The current ECS engine core (`EntityManager`) is built exclusively around a pure **Structure of Arrays (SoA)** data layout. For each component property (e.g., `Position.x`, `Position.y`), a separate `SharedArrayBuffer` is allocated per chunk.

This design provides two major benefits:
1.  **Optimal for CPU-side Systems:** It is ideal for SIMD vectorization and cache-friendly linear iteration, maximizing performance for game logic, physics, and AI systems running on the CPU.
2.  **Enables Zero-Copy Parallelism:** The use of `SharedArrayBuffer` for all data is fundamental to our high-performance parallel architecture, allowing workers to access data with no transfer overhead.

However, this pure SoA layout presents a challenge when interacting with GPUs. GPUs expect vertex data (positions, normals, UVs) in an **interleaved** format (`[P1x, P1y, P1z, N1x, N1y, N1z, ...]`) for optimal memory access. Our current architecture requires a manual, per-frame data transformation step (packing SoA data into an interleaved buffer) before rendering. This transformation can become a significant performance bottleneck, especially with large amounts of dynamic geometry.

This leads to the architectural question: Should the core ECS be extended to natively support multiple data layouts (e.g., interleaved) to avoid this transformation cost?

## Decision Drivers

*   **Performance:** The primary goal is to maximize performance across the entire engine, considering both CPU-side systems and GPU data submission.
*   **Simplicity:** The core `EntityManager` should remain as simple and predictable as possible to reduce bugs and cognitive overhead.
*   **Parallelism:** The zero-copy `SharedArrayBuffer` architecture must be preserved.
*   **Flexibility:** The engine should be able to handle different types of data and workloads efficiently.

## Considered Options

### Option 1: Status Quo (Pure SoA)

Continue with the current design. All components are stored in a pure SoA layout. A dedicated rendering system is responsible for reading the SoA data and packing it into temporary interleaved buffers for the GPU each frame.

*   **Pros:**
    *   Maximum performance for all CPU-bound systems.
    *   Keeps the `EntityManager` core simple, fast, and highly specialized.
    *   Handles complex, non-SAB data via a consistent indirection pattern (e.g., storing an ID/Ref from a manager like `AssetManager`).
    *   A single, predictable data access pattern for all systems.
*   **Cons:**
    *   The SoA-to-interleaved transformation cost is paid every frame for all visible geometry. This could become a bottleneck.

### Option 2: Add Native Support for Interleaved Layout

Modify the `EntityManager` to recognize a new `layout: 'interleaved'` flag in a component's schema. For such components, it would allocate a single `SharedArrayBuffer` for all properties combined.

*   **Pros:**
    *   **Eliminates the rendering bottleneck.** Interleaved vertex data can be passed directly to the GPU with zero transformation cost.
    *   Provides a "best of both worlds" compromise for data consumed by both CPU and GPU.
    *   Still fully compatible with the `SharedArrayBuffer` parallel architecture.
*   **Cons:**
    *   **Increases Core Complexity:** `EntityManager` functions (`_findOrCreateChunkId`, `_moveEntityToNewArchetype`, etc.) would need branching logic (`if/else`) to handle different layouts, making the core harder to maintain.
    *   **Performance Overhead:** The branching logic adds a small but constant overhead to all structural changes (entity creation, component addition/removal).
    *   **Slower for CPU:** CPU-side systems operating on this interleaved data would be slower than with pure SoA, as the layout is not SIMD-friendly for the CPU.

### Option 3: Add Native Support for AoS (Array of Structures)

This option proposes adding native support for an AoS layout specifically for components that hold direct references to complex, main-thread-only JavaScript objects (e.g., PIXI objects, custom class instances). This would be an alternative to the SoA+indirection pattern.

*   **Pros:**
    *   **Simpler Access Pattern:** Provides a direct, pointer-like way to manage complex objects (`component.sprite`) instead of requiring an indirection lookup (`assetManager.getDisplayObjectByRef(component.spriteRef)`).
    *   Conceptually simpler for developers working with non-parallelizable, object-heavy components.
*   **Cons:**
    *   **Strictly Main-Thread Only:** This layout is fundamentally incompatible with `SharedArrayBuffer` and our zero-copy parallel architecture. Its use must be strictly enforced for main-thread systems only.
    *   **Significant Core Complexity:** Requires adding a new, non-SAB-based storage type to the `EntityManager`. This complicates all structural change operations and introduces a major new paradigm into the engine's core.
    *   The existing SoA+indirection pattern already solves the problem of managing complex objects without requiring changes to the `EntityManager` core.

## Decision

**Decision:** We will **defer** implementing native support for the `interleaved` layout (Option 2) and **reject** implementing native support for the `AoS` layout (Option 3). The engine will maintain the **pure SoA layout (Option 1)** as the sole architectural standard for now.

**Justification:**

The simplicity and raw CPU performance of the pure SoA model are the strongest foundation for the engine. The complexity and overhead of introducing multiple layouts into the core `EntityManager` are not justified at this stage. The potential rendering bottleneck is a valid concern, but it should be addressed first by optimizing the transformation system itself.

AoS is rejected outright because it is architecturally incompatible with our `SharedArrayBuffer`-based parallel model and would represent a significant step backward in performance.

The complexity of adding a non-SAB, object-based storage path (AoS) to the `EntityManager` core outweighs the ergonomic benefit it provides over the existing and perfectly functional SoA+indirection pattern. This decision prioritizes a clean, maintainable, and consistently high-performance core, with the understanding that we can re-evaluate if and when data proves the SoA-to-interleaved transformation is an insurmountable bottleneck.

## Action Plan

1.  **Proceed with the pure SoA architecture.**
2.  **Isolate Data Transformation:** Implement the SoA-to-interleaved data packing logic within a dedicated `RenderSystem` or `RenderManager`.
3.  **Profile:** Actively monitor the performance of this transformation step as the engine and its content grow.
4.  **Re-evaluation Trigger:** This ADR will be revisited if profiling data shows the SoA-to-interleaved packing step consistently consumes an unacceptable portion (e.g., >15%) of the frame budget under typical application load.

---