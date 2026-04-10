const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const { entityMaskManager } = await import('@managers/EntityMaskManager/EntityMaskManager.js')


const { enableableTestComponent, trackedTestComponent, bitmaskTestTag } = ecs.getComponentIDs()

/**
 * This system is not a formal test, but a practical demonstration of how to use
 * the EntityMaskManager API for common, high-performance patterns.
 */
export class MaskAPIExampleSystem {
	init() {
		// --- General Setup ---
		this.query = this.getQuery({ with: [enableableTestComponent, trackedTestComponent, bitmaskTestTag] })

		// It's best practice for a system to manage its own scratch buffer for querying indices.
		// This avoids allocating new arrays every frame. The size should be MAX_CHUNK_CAPACITY.
		this.scratchBuffer = this.createScratchBuffer()

		// For the most performant dirty tracking, we combine broad-phase and narrow-phase checks.
		// 1. Broad-phase: A reactive query to find which CHUNKS have changed.
		this.testReactiveQuery = this.getQuery({ with: [trackedTestComponent], modified: [trackedTestComponent] })

		// Create a few entities for our examples.
		for (let i = 0; i < 5; i++) {
			this.createEntity(
				this.compile({
					enableableTestComponent: { value: 10 },
					trackedTestComponent: { value: 0 },
					bitmaskTestTag: {},
				}).payload,
			)
		}

		this.flush() // Ensure entities are created before the first update.

		// Let's start with the first entity's component disabled.
		const firstEntity = this.query.getSingleEntity()
		if (firstEntity) {
			this.disableComponentById(firstEntity, enableableTestComponent)
		}
	}

	update({ currentTick, lastTick, deltaTime }) {
		// =======================================================================
		//  USE CASE 1: ENABLEABLE COMPONENTS (e.g., applying velocity)
		// =======================================================================
		// This is the "reader" part. It only processes entities where the
		// 'velocity' component is currently enabled.

		const chunks = this.query.getChunks()
		for (const chunkId of chunks) {
			// Get a dense list of indices for entities in this chunk that have the 'velocity' bit set.
			const enabledCount = this.getEnabled(chunkId, enableableTestComponent, this.scratchBuffer)

			if (enabledCount > 0) {
				const enableableData = this.getComponentData(chunkId, enableableTestComponent)

				// Loop only over the 'enabledCount' entities. This is the performance win.
				// Instead of checking `if (isEnabled)` for every entity in the chunk, we get a
				// pre-filtered, dense list.
				for (let i = 0; i < enabledCount; i++) {
					const entityIndexInChunk = this.scratchBuffer[i]
					// Example logic: just increment the value.
					enableableData.value[entityIndexInChunk] += 1 * deltaTime
				}
			}
		}

		// This is the "writer" part. Some other system (or this one) decides when to
		// enable or disable the component's effect.
		// Let's toggle the first entity's velocity every 120 ticks.
		if (currentTick > 0 && currentTick % 240 === 0) {
			const firstEntity = this.query.getSingleEntity()

			if (firstEntity) {
				const location = this.getEntityLocation(firstEntity)
				const enabledCount = this.getEnabled(location.chunkId, enableableTestComponent, this.scratchBuffer)
				let isEnabled = false
				for (let i = 0; i < enabledCount; i++) {
					if (this.scratchBuffer[i] === location.indexInChunk) {
						isEnabled = true
						break
					}
				}

				if (isEnabled) {
					console.log(`%c[Bitmask API] Disabling test component for entity ${firstEntity}`, 'color: #f88')
					this.disableComponentById(firstEntity, enableableTestComponent)
				} else {
					console.log(`%c[Bitmask API] Enabling test component for entity ${firstEntity}`, 'color: #8f8')
					this.enableComponentById(firstEntity, enableableTestComponent)
				}
			}
		}

		// =======================================================================
		//  USE CASE 2: DIRTY TRACKING (e.g., reacting to position changes)
		// =======================================================================

		// --- The "Writer" System ---
		// Another system modifies an entity's position. To make this change "reactive",
		// it must do two things:
		// 1. Update the component data (which marks the chunk dirty for broad-phase).
		// 2. Fire a bitmask event (which marks the entity dirty for narrow-phase).
		if (currentTick > 0 && currentTick % 180 === 0) {
			const entityToModify = this.query.getSingleEntity() // Just grab the first one for the example
			if (entityToModify) {
				console.log(`%c[Bitmask API] Marking test component as modified for entity ${entityToModify}`, 'color: #88f')

				// We'll just increment its value.
				const { payload } = this.compile(trackedTestComponent, { value: currentTick })

				// 1. Update component data. This is a deferred command.
				// The CommandBufferExecutor will call EntityManager methods that automatically
				// mark the CHUNK as dirty for the broad-phase reactive query (`modified: [trackedTestComponent]`).
				this.setComponent(entityToModify, payload)

				// 2. Fire the bitmask event. This is an immediate, atomic write.
				// It marks the specific ENTITY as dirty for the narrow-phase check.
				this.markEntityDirtyById(entityToModify, trackedTestComponent, currentTick)
			}
		}

		// --- The "Reader" (Reactive) System ---
		// This system runs later and wants to efficiently find only the entities whose
		// position has changed since it last ran. It uses a two-stage filtering process.

		// Stage 1: Broad-Phase (Chunk-level filtering)
		// Use the standard reactive query to get a small list of chunks where ANY
		// trackedTestComponent has changed since `lastTick`. This is highly efficient.
		const dirtyChunks = this.testReactiveQuery.getChunks(lastTick, currentTick)

		if (dirtyChunks.length > 0) {
			for (const chunkId of dirtyChunks) {
				// Stage 2: Narrow-Phase (Entity-level filtering)
				// For each dirty chunk, use the bitmask to get the specific indices
				// of entities that have had a 'dirty' event fired.
				const modifiedCount = this.getDirty(
					chunkId,
					trackedTestComponent,
					lastTick,
					currentTick,
					this.scratchBuffer,
				)

				if (modifiedCount > 0) {
					const entities = this.getEntities(chunkId)
					for (let i = 0; i < modifiedCount; i++) {
						const entityIndex = this.scratchBuffer[i]
						const entityId = entities[entityIndex]
						console.log(
							`%c[Bitmask API] Reacted to trackedTestComponent change for entity ${entityId} in tick ${currentTick}`,
							'color: #ff8',
						)
					}
				}
			}
		}
	}

	destroy() {
		// Cleanup entities created by this example system on HMR.
		const query = this.getQuery({ with: [bitmaskTestTag] })
		this.destroyByQuery(query)
		this.flush()
	}
}
