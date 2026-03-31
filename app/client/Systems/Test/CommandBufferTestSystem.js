const { engine } = await import(`@client/Engine.js`)
const { ecs, testManager } = engine.getManagers()

const { entityManager, queryManager, prefabManager, systemManager } = ecs
const { entityStore } = await import(`@managers/EntityManager/EntityManager.js`)
const { ChunkView } = await import(`@managers/QueryManager/ChunkView.js`)

const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`)

const {
	position,
	velocity,
	rotation,
	testEntityTag,
	parent,
	entityRefComponent,
	// Import component IDs needed for the new metadata test.
	enableableTestComponent,
	trackedTestComponent,
	damageCollisionBuffer
} = ecs.getComponentIDs()

/**
 * A system dedicated to testing the functionality of the low-level CommandBuffer.
 * It runs a suite of self-contained tests for each API method during its `init` phase.
 */
export class CommandBufferTestSystem {
	constructor() {
		this.systemManager = systemManager
	}

	async init() {
		// Preload the specific prefab needed for the instantiate test.
		await prefabManager.preload(['test_prefab'])

		// --- Initialize Queries ---
		this.creationQuery = this.getQuery({
			with: [position, testEntityTag],
			without: [velocity],
		})
		this.instantiateQuery = this.getQuery({
			with: [position, velocity, testEntityTag],
		})

		// --- Initialize Payloads ---
		this.addComponentPayload = this.compile(velocity, { x: 5, y: 5 }).payload
		this.setVelocityPayload = this.compile(velocity, { x: 999, y: -999 }).payload
		this.setPositionPayload = this.compile(position, { x: 100, y: 100 }).payload
		this.generationalTestVelocityPayload = this.compile(velocity, { x: 999, y: 999 })

		const flush = () => {
			this.flush()
		}

		const cleanup = () => {
			// Use a full reset to ensure complete isolation between tests. This prevents
			// recycled chunks from previous tests (with different capacities) from
			// interfering with subsequent tests.
			entityManager.destroyAllEntities()
			flush() // Flush the cleanup commands immediately.
		}

		describe('Command Buffer API', () => {
			// Add a full cleanup at the start of the suite to ensure test isolation.
			entityManager.destroyAllEntities()
			flush()

			// --- Test 1: createEntity ---
			it('should create an entity with components via createEntity', () => {
				cleanup()
				const { payload } = this.compile({
					position: { x: 10, y: 20 },
					testEntityTag: {},
				})
				this.createEntity(payload)
				flush()

				let createdEntity
				for (const chunk of this.creationQuery.iter()) {
					createdEntity = chunk.entities[0]
					break
				}

				expect(createdEntity).not.toBe(undefined)

				const pos = ECS.getComponent(createdEntity, 'position')
				expect(pos).toEqual({ x: 10, y: 20 })
			})

			// --- Test 2: destroyEntity ---
			it('should destroy an entity via destroyEntity', () => {
				cleanup()
				const entity = ECS.createEntity({ testEntityTag: {} })

				this.destroyEntity(entity)
				flush()
				expect(entityManager.isEntityActive(entity)).toBe(false)
			})

			// --- Test 3: addComponent ---
			it('should add a component to an entity via addComponent', () => {
				cleanup()
				const entity = ECS.createEntity({
					position: { x: 1, y: 1 },
					testEntityTag: {}, // Add the tag for isolation
				})

				this.addComponent(entity, this.addComponentPayload)
				flush()
				expect(ECS.hasComponent(entity, 'velocity')).toBe(true)

				// Verify the component data was written correctly.
				const vel = ECS.getComponent(entity, 'velocity')
				expect(vel).toEqual({ x: 5, y: 5 })
			})

			// --- Test 4: removeComponent ---
			it('should remove a component from an entity via removeComponent', () => {
				cleanup()
				const entity = ECS.createEntity({
					position: {},
					velocity: { x: 5, y: 5 },
					testEntityTag: {},
				})
				this.removeComponent(entity, velocity)
				flush()
				expect(ECS.hasComponent(entity, `velocity`)).toBe(false)
			})

			// --- Test 5: setComponentData ---
			it('should set component data on an entity via setComponentData', () => {
				cleanup()
				const entity = ECS.createEntity({
					position: { x: 50, y: 50 },
					testEntityTag: {},
				})

				this.setComponentData(entity, this.setPositionPayload)
				flush()
				const pos = ECS.getComponent(entity, 'position')
				expect(pos).toEqual({ x: 100, y: 100 })
			})

			// --- Test: addComponents ---
			it('should add multiple components to an entity via addComponents', () => {
				cleanup()
				const entity = ECS.createEntity({
					position: { x: 1, y: 1 },
					testEntityTag: {},
				})

				// Compile a payload for two components
				const { payload } = this.compile({
					velocity: { x: 10, y: 20 },
					rotation: { angle: 1.57 },
				})

				this.addComponents(entity, payload)
				flush()

				expect(ECS.hasComponent(entity, 'velocity')).toBe(true)
				expect(ECS.hasComponent(entity, 'rotation')).toBe(true)
				expect(ECS.getComponent(entity, 'velocity')).toEqual({ x: 10, y: 20 })
				expect(ECS.getComponent(entity, 'rotation')).toEqual({ angle: 1.57 })
			})

			// --- Test 6: instantiate ---
			it('should instantiate an entity from a prefab with overrides', () => {
				cleanup()
				if (!prefabManager.getPrefabData('test_prefab')) {
					console.log(
						"%c[CB Test] Skipping Instantiate Test: Prefab 'test_prefab' not found or preloaded.",
						'color: gray',
					)
					return
				}
				// Compile the prefab payload with overrides using the injected compiler.
				const { payload } = this.compile('test_prefab', {
					position: { x: 123, y: 456 },
					testEntityTag: {},
				})

				this.instantiate(payload, 0)
				flush()

				let instantiatedEntity
				for (const chunk of this.instantiateQuery.iter()) {
					for (let i = 0; i < chunk.size; i++) {
						const pos = ECS.getComponent(chunk.entities[i], 'position')
						if (pos.x === 123 && pos.y === 456) {
							instantiatedEntity = chunk.entities[i]
							break
						}
					}
					if (instantiatedEntity) break
				}
				expect(instantiatedEntity).not.toBe(undefined)
			})
		})

		describe('Command Buffer (Generational Entity IDs - ABA Problem)', () => {
			it('should ignore a stale command after an entity ID is recycled (ABA)', () => {
				cleanup()

				// Step 1: Create an initial entity (A)
				const entityA_ID = ECS.createEntity({ position: { x: 1, y: 1 }, testEntityTag: {} })
				const entityA_Index = Number(entityA_ID & 0xffffffffn)
				const entityA_Generation = Number(entityA_ID >> 32n)
				expect(entityManager.isEntityActive(entityA_ID)).toBe(true)
				expect(entityA_Generation).toBeGreaterThanOrEqual(0)

				// Step 2: Queue a modification and destruction for entity A
				this.addComponent(entityA_ID, this.generationalTestVelocityPayload.payload)
				this.destroyEntity(entityA_ID)
				expect(entityManager.isEntityActive(entityA_ID)).toBe(true) // Still active before flush

				// Step 3: Execute the destruction command first
				flush()
				expect(entityManager.isEntityActive(entityA_ID)).toBe(false)

				// Step 4: Create a new entity (B) that reuses the index of A
				const entityB_ID = ECS.createEntity({ position: { x: 2, y: 2 }, testEntityTag: {} })
				const entityB_Index = Number(entityB_ID & 0xffffffffn)
				const entityB_Generation = Number(entityB_ID >> 32n)
				expect(entityManager.isEntityActive(entityB_ID)).toBe(true)
				expect(entityB_Index).toBe(entityA_Index)
				expect(entityB_Generation).toBe(entityA_Generation + 1)

				// Step 5: Process the stale addComponent command and verify it's ignored
				flush()
				const hasVelocity = ECS.hasComponent(entityB_ID, 'Velocity')
				expect(hasVelocity).toBe(false)

				// Step 6: Cleanup is handled by the next test's cleanup() call.
			})
		})

		describe('Command Buffer (Generational IDs - Advanced Scenarios)', () => {
			it('should ignore a stale setComponentData command', () => {
				cleanup()
				// --- 1. Setup ---
				const entityA_ID = ECS.createEntity({ position: { x: 1, y: 1 }, testEntityTag: {} })

				// --- 2. Defer Commands ---
				this.setComponentData(entityA_ID, this.setPositionPayload)
				this.destroyEntity(entityA_ID)

				// --- 3. Flush & Recycle ---
				flush() // Destroys entity A
				const entityB_ID = ECS.createEntity({ position: { x: 2, y: 2 }, testEntityTag: {} })

				// --- 4. Flush Stale Command ---
				flush() // Processes the stale setComponentData command

				// --- 5. Verification ---
				const posB = ECS.getComponent(entityB_ID, 'Position')
				expect(posB.x).toBe(2) // Should not be 100
				expect(posB.y).toBe(2) // Should not be 100
			})

			it('should ignore a stale removeComponent command', () => {
				cleanup()
				// --- 1. Setup ---
				const entityA_ID = ECS.createEntity({
					position: { x: 1, y: 1 },
					velocity: { x: 1, y: 1 },
					testEntityTag: {},
				})

				// --- 2. Defer Commands ---
				this.removeComponent(entityA_ID, velocity)
				this.destroyEntity(entityA_ID)

				// --- 3. Flush & Recycle ---
				flush() // Destroys entity A
				const entityB_ID = ECS.createEntity({
					position: { x: 2, y: 2 },
					velocity: { x: 2, y: 2 },
					testEntityTag: {},
				})

				// --- 4. Flush Stale Command ---
				flush() // Processes the stale removeComponent command

				// --- 5. Verification ---
				const hasVelocity = ECS.hasComponent(entityB_ID, 'Velocity')
				expect(hasVelocity).toBe(true) // Should not have been removed
			})

			it('should handle multiple recycle cycles correctly', () => {
				cleanup()
				// --- 1. Setup ---
				const entityA_ID = ECS.createEntity({ position: { x: 1, y: 1 }, testEntityTag: {} })
				const entityA_Index = Number(entityA_ID & 0xffffffffn)

				// --- 2. Defer command for original entity ---
				this.addComponent(entityA_ID, this.generationalTestVelocityPayload.payload)
				this.destroyEntity(entityA_ID)

				// --- 3. First Cycle ---
				flush() // Destroys A
				const entityB_ID = ECS.createEntity({ position: { x: 2, y: 2 }, testEntityTag: {} })
				ECS.destroyEntity(entityB_ID) // Destroy B immediately
				const entityC_ID = ECS.createEntity({ position: { x: 3, y: 3 }, testEntityTag: {} })

				// --- 4. Flush Stale Command & Verify ---
				flush() // Processes the original stale command for A
				expect(ECS.hasComponent(entityC_ID, 'Velocity')).toBe(false)
			})
		})

		describe('Command Buffer (Chunk Lifecycle)', () => {
			it('should not create zombie chunks after destroyEntitiesInChunk', () => {
				cleanup()

				// --- 1. Setup: Create enough entities to fill a chunk ---
				const { payload: creationPayload } = this.compile({
					position: {},
					testEntityTag: {},
				})
				const archetypeId = creationPayload.archetypeId
				const bytesPerEntity = entityManager.getBytesPerEntityInArchetype(archetypeId)
				const entitiesPerChunk = Math.max(16, Math.floor(16384 / bytesPerEntity))

				for (let i = 0; i < entitiesPerChunk; i++) {
					this.createEntity(creationPayload)
				}
				flush()

				// --- 2. Get the chunk to be destroyed ---
				// Use the pre-defined query that matches the created entities.
				// NOTE: `getQuery({ with: [archetypeId] })` is incorrect as `with` expects component type IDs, not archetype IDs.
				const chunkId = this.creationQuery.matchingChunkIds[0]
				expect(chunkId).toBeDefined()
				expect(entityStore.chunkSizes[chunkId]).toBe(entitiesPerChunk)

				const chunkView = new ChunkView(entityStore)
				chunkView.setChunk(chunkId)

				// --- 3. The Test: Destroy all entities in the chunk ---
				this.destroyEntitiesInChunk(chunkView)
				flush()

				// --- 4. Assertions ---
				// A "zombie" chunk would still be linked and have metadata. A properly destroyed
				// chunk will be unlinked, have its metadata cleared, and be on the free list.

				// It should be on the free list for recycling.
				expect(entityStore.freeChunkIds.includes(chunkId)).toBe(true, 'Chunk ID should be on the free list')

				// Its metadata should be cleared to prevent stale reads.
				expect(entityStore.chunkMetadata[chunkId]).toBe(undefined, 'Chunk metadata should be undefined')

				// It should be unlinked from its archetype's list.
				let isStillLinked = false
				let currentChunkId = entityStore.archetypeHeadChunkIds[archetypeId]
				while (currentChunkId !== 0) {
					// NULL_CHUNK_ID
					if (currentChunkId === chunkId) { isStillLinked = true; break; }
					currentChunkId = entityStore.chunkNextInArchetype[currentChunkId]
				}
				expect(isStillLinked).toBe(false, 'Destroyed chunk should be unlinked from its archetype')
			})

			it('should correctly recycle a chunk in the same frame it was freed', () => {
				cleanup()

				// --- 1. Setup: Create a full chunk to be destroyed ---
				const { payload: creationPayload } = this.compile({
					position: {},
					testEntityTag: {}, // This ensures it matches creationQuery
				})
				const archetypeId = creationPayload.archetypeId
				const bytesPerEntity = entityManager.getBytesPerEntityInArchetype(archetypeId)
				const entitiesPerChunk = Math.max(16, Math.floor(16384 / bytesPerEntity))

				for (let i = 0; i < entitiesPerChunk; i++) {
					this.createEntity(creationPayload)
				}
				flush()

				// Use the correct query to find the chunk.
				const chunkToDestroyId = this.creationQuery.matchingChunkIds[0]
				const chunkView = new ChunkView(entityStore)
				chunkView.setChunk(chunkToDestroyId)

				// --- 2. The Test: In a single command buffer, destroy the chunk and create a new entity ---
				// This forces the engine to free the chunk ID and then immediately try to recycle it.
				this.destroyEntitiesInChunk(chunkView)
				this.createEntity(creationPayload)
				flush()

				// --- 3. Verification ---
				// The new entity should have been placed in the recycled chunk.
				// Use the same query again to find the new entity's chunk.
				expect(this.creationQuery.count).toBe(1)
				const newChunkId = this.creationQuery.matchingChunkIds[0]
				expect(newChunkId).toBe(chunkToDestroyId, 'The new entity should be in the recycled chunk')

				// The crucial check: the recycled chunk must have valid metadata.
				// We check for `chunkArchetypeDirtyTicks` because it's always re-created on recycle,
				// unlike `chunkMetadata` which is conditional on the archetype's components.
				// A valid, re-initialized chunk must have this array.
				expect(entityStore.chunkArchetypeDirtyTicks[newChunkId]).toBeInstanceOf(Uint32Array)
				const newChunkView = new ChunkView(entityStore)
				newChunkView.setChunk(newChunkId)
				expect(newChunkView.size).toBe(1, 'Recycled chunk should contain the new entity')
			})

			it('should correctly re-initialize metadata when recycling a chunk for a different archetype', () => {
				cleanup()

				// --- 1. Create and fill a chunk with Archetype A (which has an enableable component) ---
				const { payload: payloadA } = this.compile({
					enableableTestComponent: { value: 1 },
					testEntityTag: {},
				})
				const archetypeA_Id = payloadA.archetypeId
				const bytesPerEntityA = entityManager.getBytesPerEntityInArchetype(archetypeA_Id)
				const entitiesPerChunkA = Math.max(16, Math.floor(16384 / bytesPerEntityA))

				for (let i = 0; i < entitiesPerChunkA; i++) {
					this.createEntity(payloadA)
				}
				flush()

				// --- 2. Get the chunk to be destroyed and verify its initial state ---
				const queryA = this.getQuery({ with: [enableableTestComponent, testEntityTag] })
				const chunkToRecycleId = queryA.matchingChunkIds[0]
				expect(chunkToRecycleId).toBeDefined()

				const chunkViewA = new ChunkView(entityStore)
				chunkViewA.setChunk(chunkToRecycleId)
				expect(chunkViewA.metadata).toBeDefined('Initial chunk metadata should be defined')
				expect(chunkViewA.metadata[enableableTestComponent]).toBeDefined('Initial chunk should have metadata for enableableTestComponent')
				expect(chunkViewA.metadata[trackedTestComponent]).toBeUndefined('Initial chunk should NOT have metadata for trackedTestComponent')

				// --- 3. Destroy the chunk and create a new entity with a DIFFERENT archetype (B) ---
				this.destroyEntitiesInChunk(chunkViewA)

				const { payload: payloadB } = this.compile({
					trackedTestComponent: { value: 2 },
					testEntityTag: {},
				})
				this.createEntity(payloadB)
				flush()

				// --- 4. Verification ---
				const queryB = this.getQuery({ with: [trackedTestComponent, testEntityTag] })
				expect(queryB.count).toBe(1, 'One entity with Archetype B should exist')

				const recycledChunkId = queryB.matchingChunkIds[0]
				expect(recycledChunkId).toBe(chunkToRecycleId, 'The new entity should be in the recycled chunk')

				const chunkViewB = new ChunkView(entityStore)
				chunkViewB.setChunk(recycledChunkId)
				expect(chunkViewB.metadata).toBeDefined('Recycled chunk metadata should be defined')
				expect(chunkViewB.metadata[trackedTestComponent]).toBeDefined('Recycled chunk should have metadata for trackedTestComponent')
				expect(chunkViewB.metadata[enableableTestComponent]).toBeUndefined('Recycled chunk should NOT have stale metadata for enableableTestComponent')
			})


		})



		describe('Command Buffer (Placeholder Entities)', () => {
			/**
			 * Placeholder IDs and Entity References ---
			 *
			 * ### What are Placeholder IDs?
			 *
			 * When you call `commands.createEntity()`, you don't get a real entity ID immediately.
			 * Instead, you get a temporary **placeholder ID**. This is a `BigInt` with its most
			 * significant bit set to 1. These placeholders are only valid within the scope of a
			 * single command buffer flush.
			 *
			 * ### How are they resolved?
			 *
			 * The `CommandBufferExecutor` processes all `createEntity` commands first. As each
			 * entity is created, the executor builds a map from the temporary placeholder ID to the
			 * new, real, generational entity ID.
			 *
			 * ### How do they work with components?
			 *
			 * If you create a component that references a placeholder ID (e.g., a `Parent` component
			 * on a child entity referencing its parent's placeholder), the `CommandBufferExecutor`
			 * is smart enough to patch this. Before the component is added to the entity, the
			 * executor scans its binary payload for any properties of type `entity` and replaces
			 * any placeholder IDs it finds with their corresponding real IDs from the resolution map.
			 *
			 * ### Edge Case 1: The "Dangling Pointer" (Intended and Safe)
			 *
			 * - **Scenario:** You have an entity `A` with a component `Target { entityId: B_ID }`.
			 *   In a later frame, entity `B` is destroyed.
			 * - **Behavior:** The `entityId` field in `A`'s component **still holds the old ID of B**.
			 *   This is expected. It is NOT a memory leak or a bug.
			 * - **Your Responsibility:** The system that uses this `Target` component must always
			 *   verify if the referenced entity is still valid by calling `ECS.isEntityActive(B_ID)`.
			 * - **Why it's Safe:** This is the core purpose of generational entity IDs. If `B_ID`'s
			 *   index is recycled for a new entity `C`, `isEntityActive(B_ID)` will correctly
			 *   return `false` because the generation part of the ID will not match. This prevents
			 *   the "ABA problem" where `A` would mistakenly interact with `C`.
			 *
			 * ### Edge Case 2: Created and Destroyed in the Same Frame (Handled by the Engine)
			 *
			 * - **Scenario:** You defer the creation of a `parent` and a `child`. You give the `child`
			 *   a component that references the `parent`'s placeholder ID. In the *same command buffer*,
			 *   you also defer the destruction of the `parent`.
			 * - **Behavior:** When the command buffer is flushed, the `CommandBufferExecutor` sees that
			 *   the `parent` placeholder is marked for both creation and destruction. It will skip
			 *   creating the parent entity entirely. When it later patches the child's component, it
			 *   will not find the parent's placeholder in the resolution map.
			 * - **Correct Resolution:** The executor correctly resolves this dangling reference to `0n`
			 *   (a "null" entity ID). The tests below verify this specific, critical behavior.
			 */
			it('should create a parent and child and link them using placeholders', () => {
				cleanup()
				// 1. Defer creation of parent and child, getting placeholder IDs back.
				const { payload: parentPayload } = this.compile({
					testEntityTag: {},
					position: { x: 500, y: 500 },
				})
				const parentPlaceholderId = this.createEntity(parentPayload)

				expect(parentPlaceholderId >> 63n === 1n).toBe(true) // Verify it's a placeholder

				const { payload: childPayload } = this.compile({
					testEntityTag: {},
					position: { x: 1, y: 1 },
				})
				const childPlaceholderId = this.createEntity(childPayload)

				// 2. Defer adding a 'Parent' component to the child, referencing the parent's placeholder.
				const { payload: parentComponentPayload } = this.compile(parent, {
					entityId: parentPlaceholderId,
				})
				this.addComponent(childPlaceholderId, parentComponentPayload)

				// 3. Flush the command buffer.
				flush()

				// 4. Verification
				const parentQuery = this.getQuery({ with: [parent, testEntityTag] })

				let foundChildId
				let foundParentId
				for (const chunk of parentQuery.iter()) {
					for (let i = 0; i < chunk.size; i++) {
						const parentComponent = ECS.getComponent(chunk.entities[i], 'Parent')
						foundChildId = chunk.entities[i]
						foundParentId = parentComponent.entityId
						break
					}
					if (foundChildId) break
				}

				expect(foundChildId).not.toBe(undefined)
				expect(foundParentId).not.toBe(undefined)
				expect(ECS.isEntityActive(foundChildId)).toBe(true)
				expect(ECS.isEntityActive(foundParentId)).toBe(true)

				// Verify the parent has the correct position.
				const parentPos = ECS.getComponent(foundParentId, 'position')
				expect(parentPos).toEqual({ x: 500, y: 500 })
			})

			it('should resolve a placeholder in a component to 0n if the referenced entity was destroyed', () => {
				cleanup()
				// 1. Defer creation of a parent and child.
				const { payload: parentPayload } = this.compile({ testEntityTag: {} })
				const parentPlaceholderId = this.createEntity(parentPayload)

				const { payload: childPayload } = this.compile({ testEntityTag: {} })
				const childPlaceholderId = this.createEntity(childPayload)

				// 2. Defer adding a 'Parent' component to the child, referencing the parent's placeholder.
				const { payload: parentComponentPayload } = this.compile(parent, {
					entityId: parentPlaceholderId,
				})
				this.addComponent(childPlaceholderId, parentComponentPayload)

				// 3. Crucially, also defer the destruction of the parent.
				this.destroyEntity(parentPlaceholderId)

				// 4. Flush the command buffer.
				flush()

				// 5. Verification
				const childQuery = this.getQuery({ with: [parent, testEntityTag] })
				const foundChildId = childQuery.getSingleEntity()

				expect(foundChildId).not.toBe(undefined)
				expect(ECS.isEntityActive(foundChildId)).toBe(true)

				const parentComponent = ECS.getComponent(foundChildId, 'Parent')
				// The parentId should have been resolved to 0n because the original placeholder was destroyed.
				expect(parentComponent.entityId).toBe(0n)
			})

			it('should correctly resolve multiple, mixed placeholder references in a noisy environment', () => {
				cleanup()

				// 1. Create "noise" by creating and destroying entities to populate the free index pool.
				// This ensures our main test entities don't just get sequential IDs 1, 2, 3.
				const { payload: dummyPayload } = this.compile({ testEntityTag: {} })
				const d1 = this.createEntity(dummyPayload)
				const d2 = this.createEntity(dummyPayload)
				this.destroyEntity(d1)
				this.destroyEntity(d2)
				flush() // Execute the noise generation.

				// 2. Defer creation of the main entities for the test.
				const { payload: parentPayload } = this.compile({ testEntityTag: {} })
				const parentPlaceholder = this.createEntity(parentPayload)

				const { payload: childPayload } = this.compile({ testEntityTag: {} })
				const childPlaceholder = this.createEntity(childPayload)

				const { payload: doomedPayload } = this.compile({ testEntityTag: {} })
				const doomedPlaceholder = this.createEntity(doomedPayload)

				// 3. Defer linking components with placeholder IDs.
				// Child -> Parent
				const { payload: childToParentLinkPayload } = this.compile(parent, { entityId: parentPlaceholder })
				this.addComponent(childPlaceholder, childToParentLinkPayload)

				// Child -> Doomed
				const { payload: childToDoomedLinkPayload } = this.compile(entityRefComponent, {
					target: doomedPlaceholder,
				})
				this.addComponent(childPlaceholder, childToDoomedLinkPayload)

				// Parent -> Child (bi-directional link)
				const { payload: parentToChildLinkPayload } = this.compile(parent, { entityId: childPlaceholder })
				this.addComponent(parentPlaceholder, parentToChildLinkPayload)

				// 4. Defer destruction of the 'doomed' entity.
				this.destroyEntity(doomedPlaceholder)

				// 5. Flush all commands.
				flush()

				// 6. Verification.
				// We need to find our parent and child. The parent is the one that has a 'Parent' component
				// but not an 'EntityRefComponent'. The child has both.
				const query = this.getQuery({ with: [parent, testEntityTag] })
				let realParentId, realChildId
				for (const chunk of query.iter()) {
					for (let i = 0; i < chunk.size; i++) {
						const entityId = chunk.entities[i]
						if (ECS.hasComponent(entityId, 'EntityRefComponent')) {
							realChildId = entityId
						} else {
							realParentId = entityId
						}
					}
				}

				// Assert that we found both entities and their links are correct.
				expect(realParentId).toBeDefined()
				expect(realChildId).toBeDefined()
				expect(ECS.getComponent(realChildId, 'Parent').entityId).toBe(realParentId) // Child -> Parent
				expect(ECS.getComponent(realChildId, 'EntityRefComponent').target).toBe(0n) // Child -> Doomed (null)
				expect(ECS.getComponent(realParentId, 'Parent').entityId).toBe(realChildId) // Parent -> Child
			})
		})

		// Run all the defined tests.
		await testManager.runAllTests()
	}

	destroy() {
		testManager.clear()
	}
}
