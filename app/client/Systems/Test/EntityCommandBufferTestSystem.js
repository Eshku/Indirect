const { engine } = await import(`@client/Engine.js`)
const { ecs, testManager } = engine.getManagers()

const { entityManager, prefabManager, systemManager, entityMaskManager, componentManager } = ecs
const { entityStore, MAX_COMPONENTS } = await import(`@managers/EntityManager/EntityManager.js`)

const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`)

const {
	position,
	velocity,
	rotation,
	testEntityTag,
	parent,
	entityRefComponent,
	isPooled,
	enableableTestComponent,
	trackedTestComponent,
	damageCollisionBuffer,
	destroyByQueryTag,
	alignmentTestComponent,
	lifecycleState,
} = ecs.getComponentIDs()

/**
 * A system dedicated to testing the functionality of the low-level EntityCommandBuffer.
 * It runs a suite of self-contained tests for each API method during its `init` phase.
 */
export class EntityCommandBufferTestSystem {
	constructor() {
		this.systemManager = systemManager
	}

	async init() {
		// Preload the specific prefab needed for the instantiate test.
		await prefabManager.preload(['test_prefab'])

		this.componentTypesScratch = new Uint16Array(MAX_COMPONENTS)

		// --- Initialize Queries ---
		this.creationQuery = this.getQuery({
			with: [position, testEntityTag],
			without: [velocity],
		})
		this.instantiateQuery = this.getQuery({
			with: [position, velocity, testEntityTag],
		})

		const flush = () => {
			this.flush()
		}

		const cleanup = () => {
			// Use a full reset to ensure complete isolation between tests. This prevents
			// recycled chunks from previous tests (with different capacities) from
			// interfering with subsequent tests.
			ecs.destroyAll()
			flush() // Flush the cleanup commands immediately.
			// After clearing, re-register all declarative masks for the next test.
			// This is now the responsibility of the test setup, not ECS.destroyAll().
			entityMaskManager.registerDeclarativeMasks()
		}
		
		// Get mask IDs once for all tests.
		const isSpawningMaskId = entityMaskManager.getMaskIdByName('isSpawning')
		const isActiveMaskId = entityMaskManager.getMaskIdByName('isActive')
		const isDyingMaskId = entityMaskManager.getMaskIdByName('isDying')
		const isDeadMaskId = entityMaskManager.getMaskIdByName('isDead')
		const isPooledMaskId = entityMaskManager.getMaskIdByName('isPooled')
		const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')

		// The test suite is organized by the scope and type of command buffer operation,
		// moving from simple single-entity commands to complex bulk and edge-case scenarios.

		describe('Entity Command Buffer: Core Single-Entity Commands', () => {
			it('should instantiate a single entity with components', () => {
				cleanup()
				const payload = this.compile({
					position: { x: 10, y: 20 },
					testEntityTag: {},
				})
				this.instantiate(payload, 1)
				flush()

				const createdEntity = this.creationQuery.getSingleEntity()
				expect(createdEntity).not.toBe(undefined)

				const pos = ecs.getComponent(createdEntity, 'position')
				expect(pos).toEqual({ x: 10, y: 20 })
			})

			it('should destroy an entity via destroyEntity', () => {
				cleanup()
				const entity = ecs.createEntity({ testEntityTag: {} })
				flush() // Flush creation to get a location

				expect(this.getEntityLocation(entity)).toBeDefined()
				this.destroyEntity(entity)
				flush()
				expect(entityManager.isEntityActive(entity)).toBe(false)
			})

			it('should add a component to an entity via addComponent', () => {
				cleanup()
				const entity = ecs.createEntity({
					position: { x: 1, y: 1 },
					testEntityTag: {}, // Add the tag for isolation
				})
				flush()

				expect(this.getEntityLocation(entity)).toBeDefined()
				const payload = this.compile({ velocity: { x: 5, y: 5 } })
				this.addComponent(entity, payload)
				flush()
				expect(ecs.hasComponent(entity, 'velocity')).toBe(true)

				// Verify the component data was written correctly.
				const vel = ecs.getComponent(entity, 'velocity')
				expect(vel).toEqual({ x: 5, y: 5 })
			})

			it('should add multiple components to an entity via addComponents', () => {
				cleanup()
				const entity = ecs.createEntity({
					position: { x: 1, y: 1 },
					testEntityTag: {},
				})
				flush()

				// Compile a payload for two components
				const payload = this.compile({
					velocity: { x: 10, y: 20 },
					rotation: { angle: 1.57 },
				})

				expect(this.getEntityLocation(entity)).toBeDefined()
				this.addComponents(entity, payload)
				flush()

				expect(ecs.hasComponent(entity, 'velocity')).toBe(true)
				expect(ecs.hasComponent(entity, 'rotation')).toBe(true)
				expect(ecs.getComponent(entity, 'velocity')).toEqual({ x: 10, y: 20 })
				expect(ecs.getComponent(entity, 'rotation')).toEqual({ angle: 1.57 })
			})

			it('should remove a component from an entity via removeComponent', () => {
				cleanup()
				const entity = ecs.createEntity({
					position: {},
					velocity: { x: 5, y: 5 },
					testEntityTag: {},
				})
				flush()

				expect(this.getEntityLocation(entity)).toBeDefined()
				this.removeComponent(entity, velocity)
				flush()
				expect(ecs.hasComponent(entity, `velocity`)).toBe(false)
			})

			it('should remove multiple components from a single entity via removeComponents', () => {
				cleanup()

				// 1. Create an entity with multiple components.
				const entity = ecs.createEntity({ position: {}, velocity: {}, rotation: {}, testEntityTag: {} })
				flush()

				expect(ecs.hasComponent(entity, 'position')).toBe(true)
				expect(ecs.hasComponent(entity, 'velocity')).toBe(true)
				expect(ecs.hasComponent(entity, 'rotation')).toBe(true)

				// 2. Call the bulk remove command for two components on the single entity.
				this.removeComponents(entity, [velocity, rotation])
				flush()

				// 3. Verification
				expect(ecs.hasComponent(entity, 'position')).toBe(true)
				expect(ecs.hasComponent(entity, 'testEntityTag')).toBe(true)
				expect(ecs.hasComponent(entity, 'velocity')).toBe(false)
				expect(ecs.hasComponent(entity, 'rotation')).toBe(false)
			})

			it('should set component data on an entity via setComponent', () => {
				cleanup()
				const entity = ecs.createEntity({
					position: { x: 50, y: 50 },
					testEntityTag: {},
				})
				flush()

				expect(this.getEntityLocation(entity)).toBeDefined()
				const payload = this.compile({ position: { x: 100, y: 100 } })
				this.setComponent(entity, payload)
				flush()
				const pos = ecs.getComponent(entity, 'position')
				expect(pos).toEqual({ x: 100, y: 100 })
			})
			
			it('should NOT update state masks on deferred setComponentSilent', () => {
				cleanup()
				const entity = ecs.createEntity({ lifecycleState: { state: LIFECYCLE.ACTIVE } })
				flush()
				const setPayload = this.compile({ lifecycleState: { state: LIFECYCLE.DYING } })
				this.setComponentSilent(entity, setPayload)
				flush()
				expect(this.isBitSet(isActiveMaskId, this.getEntityLocation(entity).chunkId, this.getEntityLocation(entity).indexInChunk)).toBe(true, 'isActive mask should NOT be cleared by silent set')
			})

			it('should reset an entity to schema defaults using a defaults payload', () => {
				cleanup()

				// 1. Create an entity and modify its state
				const entity = ecs.createEntity({
					position: { x: 123, y: 456 },
					velocity: { x: 10, y: 10 },
					testEntityTag: {},
				})
				flush()
				expect(ecs.getComponent(entity, 'position')).toEqual({ x: 123, y: 456 })

				// 2. Compile a defaults payload for the entity's archetype
				// Position defaults to {x:0, y:0}, Velocity defaults to {x:0, y:0}
				const defaultsPayload = this.compile({
					position: {},
					velocity: { y: 5 }, //x not specified, default implied.
				})

				// 3. Use setComponents to apply the defaults
				expect(this.getEntityLocation(entity)).toBeDefined()
				this.setComponents(entity, defaultsPayload)
				flush()

				// 4. Verification - The components should now have their schema default values
				expect(ecs.getComponent(entity, 'position')).toEqual({ x: 0, y: 0 })
				expect(ecs.getComponent(entity, 'velocity')).toEqual({ x: 0, y: 5 })
			})

			it('should correctly handle adding a tag component and updating queries', () => {
				cleanup()

				// 1. Setup
				const query = this.getQuery({ with: [testEntityTag], without: [isPooled] })
				const pooledQuery = this.getQuery({ with: [testEntityTag, isPooled] })

				// this.instantiate returns a placeholder. We must flush and then get the real entity.
				this.instantiate(this.compile({ testEntityTag: {} }), 1)
				flush()

				// 2. Initial verification
				const entity = query.getSingleEntity() // Get the real entity ID from the query.
				expect(entity).toBeDefined('Test entity should be found after creation.')
				expect(query.count).toBe(1)
				expect(pooledQuery.count).toBe(0)
				expect(this.getEntityLocation(entity)).toBeDefined()

				// 3. Action: Add the tag component
				const payload = this.compile({ isPooled: {} })
				this.addComponent(entity, payload)
				flush()

				// 4. Final verification
				expect(query.count).toBe(0, 'Entity should no longer match `without` query after adding the tag.')
				expect(pooledQuery.count).toBe(1, 'Entity should now match `with` query after adding the tag.')
			})

			it('should reset an entity to defaults with overrides using a defaults payload', () => {
				cleanup()

				// 1. Create an entity and modify its state
				const entity = ecs.createEntity({
					position: { x: 123, y: 456 },
					velocity: { x: 10, y: 10 },
					testEntityTag: {},
				})
				flush()
				expect(ecs.getComponent(entity, 'position')).toEqual({ x: 123, y: 456 })

				// 2. Compile a defaults payload, but this time provide an override for position.
				const defaultsPayload = this.compile({
					position: { x: -1, y: -1 }, // Override the default for position
					velocity: {}, // Use schema default for velocity
				})

				// 3. Use setComponents to apply the defaults
				expect(this.getEntityLocation(entity)).toBeDefined()
				this.setComponents(entity, defaultsPayload)
				flush()

				// 4. Verification - Position should be the override, Velocity should be the schema default.
				expect(ecs.getComponent(entity, 'position')).toEqual({ x: -1, y: -1 })
				expect(ecs.getComponent(entity, 'velocity')).toEqual({ x: 0, y: 0 })
			})
		})

		describe('Entity Command Buffer: Bulk Commands', () => {
			it('should create a batch of identical entities via instantiate', () => {
				cleanup()
				const payload = this.compile(
					{
						position: { x: 11, y: 22 },
						testEntityTag: {},
					},
					{ count: 10 },
				)
				this.instantiate(payload, payload.capacity)
				flush()

				const query = this.getQuery({ with: [position, testEntityTag] })
				expect(query.count).toBe(10)

				const chunkIds = query.getChunks()
				for (const chunkId of chunkIds) {
					const positions = this.getComponentData(chunkId, position)
					const size = this.getChunkSize(chunkId)
					for (let i = 0; i < size; i++) {
						expect(positions.x[i]).toBe(11)
						expect(positions.y[i]).toBe(22)
					}
				}
			})

			it('should create a batch of varied entities using a live payload', () => {
				cleanup()

				// 1. Compile a live SoA payload with capacity.
				const payload = this.compile(
					{
						velocity: { x: 1, y: 1 }, // All entities will have this
						position: {}, // Default data
						testEntityTag: {},
					},
					{ count: 3 },
				)

				// 2. Write varied data directly to the payload's buffers.
				payload.buffers.position.x[0] = 100
				payload.buffers.position.y[0] = 100
				payload.buffers.position.x[1] = 200
				payload.buffers.position.y[1] = 200
				payload.buffers.position.x[2] = 300
				payload.buffers.position.y[2] = 300

				this.instantiate(payload, payload.capacity)
				flush()

				// 3. Verification
				const query = this.getQuery({ with: [position, velocity, testEntityTag] })
				expect(query.count).toBe(3)

				const entities = query
					.getChunks()
					.flatMap(chunkId => Array.from(this.getEntities(chunkId).slice(0, this.getChunkSize(chunkId))))

				// Sort entities by their position to have a predictable order for checking values.
				entities.sort((a, b) => ecs.getComponent(a, 'position').x - ecs.getComponent(b, 'position').x)

				expect(ecs.getComponent(entities[0], 'position')).toEqual({ x: 100, y: 100 })
				expect(ecs.getComponent(entities[1], 'position')).toEqual({ x: 200, y: 200 })
				expect(ecs.getComponent(entities[2], 'position')).toEqual({ x: 300, y: 300 })
				expect(ecs.getComponent(entities[0], 'velocity')).toEqual({ x: 1, y: 1 })
				expect(ecs.getComponent(entities[1], 'velocity')).toEqual({ x: 1, y: 1 })
				expect(ecs.getComponent(entities[2], 'velocity')).toEqual({ x: 1, y: 1 })
			})

			it('should instantiate a partial count from a larger capacity payload', () => {
				cleanup()

				// 1. Compile a payload with a capacity of 10.
				const payload = this.compile(
					{
						position: {},
						testEntityTag: {},
					},
					{ count: 10 },
				)

				// 2. Write varied data to the first 3 slots.
				payload.buffers.position.x[0] = 10
				payload.buffers.position.y[0] = 10
				payload.buffers.position.x[1] = 20
				payload.buffers.position.y[1] = 20
				payload.buffers.position.x[2] = 30
				payload.buffers.position.y[2] = 30

				// 3. Instantiate only 3 entities from the payload.
				this.instantiate(payload, 3)
				flush()

				// 4. Verification
				const query = this.getQuery({ with: [position, testEntityTag] })
				expect(query.count).toBe(3, 'Should only create the specified number of entities, not the full capacity.')

				const entities = query
					.getChunks()
					.flatMap(chunkId => Array.from(this.getEntities(chunkId).slice(0, this.getChunkSize(chunkId))))

				// Sort entities by their position to have a predictable order for checking values.
				entities.sort((a, b) => ecs.getComponent(a, 'position').x - ecs.getComponent(b, 'position').x)

				expect(ecs.getComponent(entities[0], 'position')).toEqual({ x: 10, y: 10 })
				expect(ecs.getComponent(entities[1], 'position')).toEqual({ x: 20, y: 20 })
				expect(ecs.getComponent(entities[2], 'position')).toEqual({ x: 30, y: 30 })
			})

			it('should instantiate a single entity when count is omitted', () => {
				cleanup()
				const payload = this.compile({
					position: { x: 99, y: 99 },
					testEntityTag: {},
				})

				// Call instantiate without the count argument. It should default to 1.
				this.instantiate(payload)
				flush()

				const query = this.getQuery({ with: [position, testEntityTag] })
				expect(query.count).toBe(1)

				const entity = query.getSingleEntity()
				expect(entity).toBeDefined()
				expect(ecs.getComponent(entity, 'position')).toEqual({ x: 99, y: 99 })
			})

			it('should add multiple components to multiple entities via addComponentsToEntities', () => {
				cleanup()

				// 1. Create a batch of entities.
				const creationPayload = this.compile({ position: {} }, { count: 5 })
				this.instantiate(creationPayload, 5)
				flush()

				const query = this.getQuery({ with: [position], without: [rotation, isPooled] })
				expect(query.count).toBe(5)

				const entities = query
					.getChunks()
					.flatMap(chunkId => Array.from(this.getEntities(chunkId).slice(0, this.getChunkSize(chunkId))))
				expect(entities.length).toBe(5)

				// 2. Compile a payload for the new components.
				const addPayload = this.compile({
					rotation: { angle: 1.23 },
					isPooled: {},
				})

				// 3. Call the bulk add command.
				this.addComponentsToEntities(entities, addPayload)
				flush()

				// 4. Verification
				const finalQuery = this.getQuery({ with: [position, rotation, isPooled] })
				expect(finalQuery.count).toBe(5)

				const finalChunkIds = finalQuery.getChunks()
				for (const chunkId of finalChunkIds) {
					const rotations = this.getComponentData(chunkId, rotation)
					for (let i = 0; i < this.getChunkSize(chunkId); i++) {
						expect(rotations.angle[i]).toBeCloseTo(1.23)
					}
				}
			})

			it('should remove multiple components from multiple entities via removeComponentsFromEntities', () => {
				cleanup()

				// 1. Create a batch of entities with multiple components.
				const creationPayload = this.compile({ position: {}, velocity: {}, rotation: {} }, { count: 5 })
				this.instantiate(creationPayload, 5)
				flush()

				const query = this.getQuery({ with: [position, velocity, rotation] })
				expect(query.count).toBe(5)
				const entities = query
					.getChunks()
					.flatMap(chunkId => Array.from(this.getEntities(chunkId).slice(0, this.getChunkSize(chunkId))))
				expect(entities.length).toBe(5)

				// 2. Call the bulk remove command for two components.
				this.removeComponentsFromEntities(entities, [velocity, rotation])
				flush()

				// 3. Verification
				const finalQuery = this.getQuery({ with: [position], without: [velocity, rotation] })
				expect(finalQuery.count).toBe(5)

				for (const entityId of entities) {
					expect(ecs.hasComponent(entityId, 'position')).toBe(true)
					expect(ecs.hasComponent(entityId, 'velocity')).toBe(false)
					expect(ecs.hasComponent(entityId, 'rotation')).toBe(false)
				}
			})

			it('should reset multiple entities to a default state via setEntities', () => {
				cleanup()

				// 1. Create a batch of entities with non-default state.
				const creationPayload = this.compile(
					{
						position: { x: 100, y: 100 },
						velocity: { x: 50, y: 50 },
						testEntityTag: {},
					},
					{ count: 5 },
				)
				this.instantiate(creationPayload, 5)
				flush()

				const query = this.getQuery({ with: [position, velocity, testEntityTag] })
				expect(query.count).toBe(5)
				const entities = query
					.getChunks()
					.flatMap(chunkId => Array.from(this.getEntities(chunkId).slice(0, this.getChunkSize(chunkId))))

				// Verify initial state
				const pos1 = ecs.getComponent(entities[0], 'position')
				expect(pos1).toEqual({ x: 100, y: 100 })

				// 2. Compile a "reset" payload.
				// Position defaults to {x:0, y:0}. Velocity will be overridden.
				const resetPayload = this.compile({
					position: {}, // Reset to schema default
					velocity: { x: -1, y: -1 }, // Override default
				})

				// 3. Use the new setEntities command.
				this.setEntities(entities, resetPayload)
				flush()

				// 4. Verification
				expect(query.count).toBe(5) // No structural change
				for (const entityId of entities) {
					const pos = ecs.getComponent(entityId, 'position')
					const vel = ecs.getComponent(entityId, 'velocity')
					expect(pos).toEqual({ x: 0, y: 0 }) // Should be reset to schema default
					expect(vel).toEqual({ x: -1, y: -1 }) // Should be the override value
				}
			})

			it('should destroy multiple entities via destroyByQuery', () => {
				cleanup()

				// 1. Setup
				const queryToDestroy = this.getQuery({ with: [destroyByQueryTag] })
				const controlQuery = this.getQuery({ with: [testEntityTag], without: [destroyByQueryTag] })

				const destroyPayload = this.compile({ destroyByQueryTag: {}, position: {} }, { count: 10 })
				const controlPayload = this.compile({ testEntityTag: {}, position: {} }, { count: 5 })

				// Create 10 entities to be destroyed
				this.instantiate(destroyPayload, 10)
				// Create 5 control entities that should not be destroyed
				this.instantiate(controlPayload, 5)
				flush()

				// 2. Assert initial state
				expect(queryToDestroy.count).toBe(10)
				expect(controlQuery.count).toBe(5)

				// 3. Action
				this.destroyByQuery(queryToDestroy)
				flush()

				// 4. Verification
				expect(queryToDestroy.count).toBe(0, 'All entities matching the query should be destroyed')
				expect(controlQuery.count).toBe(5, 'Control group entities should not be affected')
			})
		})

		describe('Entity Command Buffer: Placeholder Scenarios', () => {
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
			 * The `CommandBufferE` processes all `createEntity` commands first. As each
			 * entity is created, the executor builds a map from the temporary placeholder ID to the
			 * new, real, generational entity ID.
			 *
			 * ### How do they work with components?
			 *
			 * If you create a component that references a placeholder ID (e.g., a `Parent` component
			 * on a child entity referencing its parent's placeholder), the `CommandBuffer`
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
			 * - **Behavior:** When the command buffer is flushed, the `CommandBuffer` sees that
			 *   the `parent` placeholder is marked for both creation and destruction. It will skip
			 *   creating the parent entity entirely. When it later patches the child's component, it
			 *   will not find the parent's placeholder in the resolution map.
			 * - **Correct Resolution:** The executor correctly resolves this dangling reference to `0n`
			 *   (a "null" entity ID). The tests below verify this specific, critical behavior.
			 */
			it('should create a parent and child and link them using placeholders', () => {
				cleanup()
				// 1. Defer creation of parent and child, getting placeholder IDs back.
				const parentPayload = this.compile({
					testEntityTag: {},
					position: { x: 500, y: 500 },
				})
				const parentPlaceholderId = this.instantiate(parentPayload, 1)

				expect(parentPlaceholderId >> 63n === 1n).toBe(true) // Verify it's a placeholder

				const childPayload = this.compile({
					testEntityTag: {},
					position: { x: 1, y: 1 },
				})
				const childPlaceholderId = this.instantiate(childPayload, 1)

				// 2. Defer adding a 'Parent' component to the child, referencing the parent's placeholder.
				const parentComponentPayload = this.compile({
					parent: {
						entityId: parentPlaceholderId,
					},
				})
				this.addComponent(childPlaceholderId, parentComponentPayload)

				// 3. Flush the command buffer.
				flush()

				// 4. Verification
				const parentQuery = this.getQuery({ with: [parent, testEntityTag] })

				const foundChildId = parentQuery.getSingleEntity()
				const foundParentId = foundChildId ? ecs.getComponent(foundChildId, 'Parent').entityId : undefined
				expect(foundChildId).not.toBe(undefined)
				expect(foundParentId).not.toBe(undefined)
				expect(ecs.isEntityActive(foundChildId)).toBe(true)
				expect(ecs.isEntityActive(foundParentId)).toBe(true)

				// Verify the parent has the correct position.
				const parentPos = ecs.getComponent(foundParentId, 'position')
				expect(parentPos).toEqual({ x: 500, y: 500 })
			})

			it('should resolve a placeholder in a component to 0n if the referenced entity was destroyed', () => {
				cleanup()
				// 1. Defer creation of a parent and child.
				const parentPayload = this.compile({ testEntityTag: {} })
				const parentPlaceholderId = this.instantiate(parentPayload, 1)

				const childPayload = this.compile({ testEntityTag: {} })
				const childPlaceholderId = this.instantiate(childPayload, 1)

				// 2. Defer adding a 'Parent' component to the child, referencing the parent's placeholder.
				const parentComponentPayload = this.compile({
					parent: {
						entityId: parentPlaceholderId,
					},
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
				expect(ecs.isEntityActive(foundChildId)).toBe(true)

				const parentComponent = ecs.getComponent(foundChildId, 'Parent')
				// The parentId should have been resolved to 0n because the original placeholder was destroyed.
				expect(parentComponent.entityId).toBe(0n)
			})

			it('should correctly resolve multiple, mixed placeholder references in a noisy environment', () => {
				cleanup()

				// 1. Create "noise" by creating and destroying entities to populate the free index pool.
				// This ensures our main test entities don't just get sequential IDs 1, 2, 3.
				const dummyPayload = this.compile({ testEntityTag: {} })
				const d1 = this.instantiate(dummyPayload, 1)
				const d2 = this.instantiate(dummyPayload, 1)
				this.destroyEntity(d1)
				this.destroyEntity(d2)
				flush() // Execute the noise generation.

				// 2. Defer creation of the main entities for the test.
				const parentPayload = this.compile({ testEntityTag: {} })
				const parentPlaceholder = this.instantiate(parentPayload, 1)

				const childPayload = this.compile({ testEntityTag: {} })
				const childPlaceholder = this.instantiate(childPayload, 1)

				const doomedPayload = this.compile({ testEntityTag: {} })
				const doomedPlaceholder = this.instantiate(doomedPayload, 1)

				// 3. Defer linking components with placeholder IDs.
				// Child -> Parent
				const childToParentLinkPayload = this.compile({ parent: { entityId: parentPlaceholder } })
				this.addComponent(childPlaceholder, childToParentLinkPayload)

				// Child -> Doomed
				const childToDoomedLinkPayload = this.compile({
					entityRefComponent: {
						target: doomedPlaceholder,
					},
				})
				this.addComponent(childPlaceholder, childToDoomedLinkPayload)

				// Parent -> Child (bi-directional link)
				const parentToChildLinkPayload = this.compile({ parent: { entityId: childPlaceholder } })
				this.addComponent(parentPlaceholder, parentToChildLinkPayload)

				// 4. Defer destruction of the 'doomed' entity.
				this.destroyEntity(doomedPlaceholder)

				// 5. Flush all commands.
				flush()

				// 6. Verification.
				// We need to find our parent and child. The parent is the one that has a 'Parent' component
				// but not an 'EntityRefComponent'. The child has both.
				const query = this.getQuery({ with: [parent, testEntityTag] })
				const allEntities = query
					.getChunks()
					.flatMap(chunkId => Array.from(this.getEntities(chunkId).slice(0, this.getChunkSize(chunkId))))
				const realChildId = allEntities.find(e => ecs.hasComponent(e, 'EntityRefComponent'))
				const realParentId = allEntities.find(e => !ecs.hasComponent(e, 'EntityRefComponent'))

				// Assert that we found both entities and their links are correct.
				expect(realParentId).toBeDefined()
				expect(realChildId).toBeDefined()
				expect(ecs.getComponent(realChildId, 'Parent').entityId).toBe(realParentId) // Child -> Parent
				expect(ecs.getComponent(realChildId, 'EntityRefComponent').target).toBe(0n) // Child -> Doomed (null)
				expect(ecs.getComponent(realParentId, 'Parent').entityId).toBe(realChildId) // Parent -> Child
			})
		})

		describe('Entity Command Buffer (Placeholder Setters)', () => {
			it('should correctly apply setComponents with multiple components to a placeholder entity', () => {
				cleanup()

				// 1. Defer creation of an entity.
				const creationPayload = this.compile({
					position: { x: 0, y: 0 }, // Start with default position
					velocity: { x: 0, y: 0 }, // and velocity
					rotation: { angle: 0 },
					testEntityTag: {},
				})
				const placeholderId = this.instantiate(creationPayload, 1)

				// 2. Defer setting components on the new entity.
				// This payload contains multiple components to test the batching logic thoroughly.
				const setPayload = this.compile({
					position: { x: 777, y: 888 },
					velocity: { x: -10, y: 10 },
					rotation: { angle: 3.14 },
				})

				this.setComponents(placeholderId, setPayload)

				// 3. Flush
				flush()

				// 4. Verification - The entity should now have all three components with the correct values.
				const query = this.getQuery({ with: [position, velocity, rotation, testEntityTag] })
				const entityId = query.getSingleEntity()
				expect(entityId).toBeDefined()

				const pos = ecs.getComponent(entityId, 'position')
				expect(pos).toEqual({ x: 777, y: 888 })

				const vel = ecs.getComponent(entityId, 'velocity')
				expect(vel).toEqual({ x: -10, y: 10 })

				const rot = ecs.getComponent(entityId, 'rotation')
				expect(rot.angle).toBeCloseTo(3.14)
			})


			it('should create identical entities and allow them to be referenced by placeholder', () => {
				cleanup()
				const creationPayload = this.compile(
					{
						position: { x: 11, y: 22 },
						testEntityTag: {},
					},
					{ count: 3 },
				)

				const firstPlaceholderId = this.instantiate(creationPayload, creationPayload.capacity)
				expect(firstPlaceholderId).toBeDefined()

				// Add a 'velocity' component to the second placeholder entity.
				const addPayload = this.compile({ velocity: { x: 100, y: 100 } })
				this.addComponent(firstPlaceholderId + 1n, addPayload)

				flush()

				// Verification
				const queryAll = this.getQuery({ with: [position, testEntityTag] })
				expect(queryAll.count).toBe(3)

				const queryWithVelocity = this.getQuery({ with: [position, testEntityTag, velocity] })
				expect(queryWithVelocity.count).toBe(1)

				const modifiedEntity = queryWithVelocity.getSingleEntity()
				expect(modifiedEntity).toBeDefined()

				const vel = ecs.getComponent(modifiedEntity, 'velocity')
				expect(vel).toEqual({ x: 100, y: 100 })
			})

			it('should reset multiple entities (with placeholder IDs) to a default state via setEntities', () => {
				//both of those tests are not really about "defaults"
				// it is about setting data on multiple entities
				// placeholders and real entities
				// but defaults are fine too.

				cleanup()

				// 1. Defer creation of a batch of entities, getting placeholder IDs back.
				const creationPayload = this.compile(
					{
						position: { x: 100, y: 100 },
						velocity: { x: 50, y: 50 },
						testEntityTag: {},
					},
					{ count: 5 },
				)
				const firstPlaceholderId = this.instantiate(creationPayload, 5)
				expect(firstPlaceholderId).toBeDefined()
				expect(firstPlaceholderId >> 63n === 1n).toBe(true) // Verify it's a placeholder
				const placeholderIds = Array.from({ length: 5 }, (_, i) => firstPlaceholderId + BigInt(i))

				// 2. Compile a "reset" payload.
				const resetPayload = this.compile({
					position: {}, // Reset to schema default
					velocity: { x: -1, y: -1 }, // Override default
				})

				// 3. Use setEntities with the placeholder IDs BEFORE flushing.
				this.setEntities(placeholderIds, resetPayload)

				// 4. Flush all commands (creation and setEntities).
				flush()

				// 5. Verification
				const query = this.getQuery({ with: [position, velocity, testEntityTag] })
				expect(query.count).toBe(5) // No structural change from the setEntities

				const chunkIds = query.getChunks()
				for (const chunkId of chunkIds) {
					const entities = this.getEntities(chunkId)
					for (let i = 0; i < this.getChunkSize(chunkId); i++) {
						const pos = ecs.getComponent(entities[i], 'position')
						const vel = ecs.getComponent(entities[i], 'velocity')
						// The setEntities command should have overwritten the creation data.
						expect(pos).toEqual({ x: 0, y: 0 }) // Should be reset to schema default
						expect(vel).toEqual({ x: -1, y: -1 }) // Should be the override value
					}
				}
			})

			it('should not apply a command for a real entity to a placeholder with the same index', () => {
				cleanup()

				// 1. Create a real entity. In a clean test, its index will be 1.
				const realEntity = ecs.createEntity({ position: { x: 0, y: 0 } })
				flush()
				const realEntityIndex = Number(realEntity & 0xffffffffn)

				// 2. In a new command buffer, create a batch of entities that will generate
				// a placeholder with the same index as our real entity.
				const batchSize = realEntityIndex + 1
				const creationPayload = this.compile({ testEntityTag: {} }, { count: batchSize })
				this.instantiate(creationPayload, batchSize)

				// 3. In the same command buffer, issue a `setComponent` command for the REAL entity.
				const setPayload = this.compile({ position: { x: 999, y: 999 } })
				this.setComponent(realEntity, setPayload)

				// 4. Execute all commands.
				flush()

				// 5. Verification
				// The real entity's position should have been updated.
				const realPos = ecs.getComponent(realEntity, 'position')
				expect(realPos).toEqual({ x: 999, y: 999 })

				// Verification: Check if any of the newly created entities (from the batch)
				// were incorrectly given a `position` component.
				const query = this.getQuery({ with: [testEntityTag] })
				let misappliedCount = 0
				const chunkIds = query.getChunks()
				for (const chunkId of chunkIds) {
					const entities = this.getEntities(chunkId)
					for (let i = 0; i < this.getChunkSize(chunkId); i++) {
						// The bug would have caused a structural change, adding the position component.
						if (ecs.hasComponent(entities[i], 'position')) {
							misappliedCount++
						}
					}
				}
				expect(misappliedCount).toBe(
					0,
					'No entities from the batch should have had a position component added to them.',
				)
			})
		})

		describe('Entity Command Buffer: Generational ID & ABA Scenarios', () => {
			it('should ignore a stale addComponent command after an entity ID is recycled (ABA)', () => {
				cleanup()

				// Step 1: Create an initial entity (A)
				const entityA_ID = ecs.createEntity({ position: { x: 1, y: 1 }, testEntityTag: {} })
				flush()

				const entityA_Index = Number(entityA_ID & 0xffffffffn)
				const entityA_Generation = Number(entityA_ID >> 32n)
				const locationA = this.getEntityLocation(entityA_ID)
				expect(entityManager.isEntityActive(entityA_ID)).toBe(true)
				expect(entityA_Generation).toBeGreaterThanOrEqual(0)
				expect(locationA).toBeDefined()

				// Step 2: Queue a modification and destruction for entity A
				this.addComponent(entityA_ID, this.compile({ velocity: { x: 999, y: 999 } }))
				this.destroyEntity(entityA_ID)
				expect(entityManager.isEntityActive(entityA_ID)).toBe(true) // Still active before flush

				// Step 3: Execute the commands. The new executor will correctly ignore the stale addComponent.
				flush()
				expect(entityManager.isEntityActive(entityA_ID)).toBe(false)

				// Step 4: Create a new entity (B) that reuses the index of A
				const entityB_ID = ecs.createEntity({ position: { x: 2, y: 2 }, testEntityTag: {} })
				flush()

				const entityB_Index = Number(entityB_ID & 0xffffffffn)
				const entityB_Generation = Number(entityB_ID >> 32n)
				expect(entityManager.isEntityActive(entityB_ID)).toBe(true)
				expect(entityA_Index).toBe(entityB_Index)
				expect(entityB_Generation).toBe(entityA_Generation + 1)

				// Step 5: Process the stale addComponent command and verify it's ignored
				flush()
				const hasVelocity = ecs.hasComponent(entityB_ID, 'Velocity')
				expect(hasVelocity).toBe(false)
			})

			it('should ignore a stale setComponent command', () => {
				cleanup()
				// --- 1. Setup ---
				const entityA_ID = ecs.createEntity({ position: { x: 1, y: 1 }, testEntityTag: {} })
				flush()

				// --- 2. Defer Commands ---
				this.setComponent(entityA_ID, this.compile({ position: { x: 100, y: 100 } }))
				this.destroyEntity(entityA_ID)

				// --- 3. Flush & Recycle ---
				flush() // Destroys entity A
				const entityB_ID = ecs.createEntity({ position: { x: 2, y: 2 }, testEntityTag: {} })
				flush()

				// --- 4. Flush Stale Command ---
				flush() // Processes the stale setComponentData command

				// --- 5. Verification ---
				const posB = ecs.getComponent(entityB_ID, 'Position')
				expect(posB.x).toBe(2) // Should not be 100
				expect(posB.y).toBe(2) // Should not be 100
			})

			it('should ignore a stale removeComponent command', () => {
				cleanup()
				// --- 1. Setup ---
				const entityA_ID = ecs.createEntity({
					position: { x: 1, y: 1 },
					velocity: { x: 1, y: 1 },
					testEntityTag: {},
				})
				flush()

				// --- 2. Defer Commands ---
				this.removeComponent(entityA_ID, velocity)
				this.destroyEntity(entityA_ID)

				// --- 3. Flush & Recycle ---
				flush() // Destroys entity A
				const entityB_ID = ecs.createEntity({
					position: { x: 2, y: 2 },
					velocity: { x: 2, y: 2 },
					testEntityTag: {},
				})
				flush()

				// --- 4. Flush Stale Command ---
				flush() // Processes the stale removeComponent command

				// --- 5. Verification ---
				const hasVelocity = ecs.hasComponent(entityB_ID, 'Velocity')
				expect(hasVelocity).toBe(true) // Should not have been removed
			})

			it('should handle multiple recycle cycles correctly', () => {
				cleanup()
				// --- 1. Setup ---
				const entityA_ID = ecs.createEntity({ position: { x: 1, y: 1 }, testEntityTag: {} })
				flush()

				// --- 2. Defer command for original entity ---
				this.addComponent(entityA_ID, this.compile({ velocity: { x: 999, y: 999 } }))
				this.destroyEntity(entityA_ID)

				// --- 3. First Cycle ---
				flush() // Destroys A
				const entityB_ID = ecs.createEntity({ position: { x: 2, y: 2 }, testEntityTag: {} })
				flush()
				ecs.destroyEntity(entityB_ID) // Destroy B immediately
				const entityC_ID = ecs.createEntity({ position: { x: 3, y: 3 }, testEntityTag: {} })

				// --- 4. Flush Stale Command & Verify ---
				flush() // Processes the original stale command for A
				expect(ecs.hasComponent(entityC_ID, 'Velocity')).toBe(false)
			})
		})

		describe('Entity Command Buffer: Chunk & Memory Integrity', () => {
			it('should correctly create entities across a chunk boundary', () => {
				cleanup()

				// 1. Define an archetype and calculate its chunk capacity.
				const templatePayload = this.compile({
					position: { x: 1, y: 2 },
					velocity: { x: 3, y: 4 },
					testEntityTag: {},
				})
				const archetypeId = templatePayload.archetypeId
				const bytesPerEntity = entityManager.getBytesPerEntityInArchetype(archetypeId)
				const entitiesPerChunk = Math.max(16, Math.floor(16384 / bytesPerEntity))

				// 2. Set a creation count that is guaranteed to cross a chunk boundary.
				const countToCreate = entitiesPerChunk + 5
				expect(countToCreate).toBeGreaterThan(entitiesPerChunk)

				// 3. Compile a payload with the required capacity and instantiate.
				const payload = this.compile(
					{
						position: { x: 123, y: 456 },
						velocity: { x: 7, y: 8 },
						testEntityTag: {},
					},
					{ count: countToCreate },
				)
				this.instantiate(payload, countToCreate)
				flush()

				// 4. Verification
				const query = this.getQuery({ with: [position, velocity, testEntityTag] })
				expect(query.count).toBe(countToCreate)

				// Verify that the entities are in at least two different chunks.
				const chunkIds = query.getChunks()
				expect(chunkIds.length).toBeGreaterThanOrEqual(2)

				// Verify that the data is correct for all entities, regardless of which chunk they are in.
				let verifiedCount = 0
				for (const chunkId of chunkIds) {
					const positions = this.getComponentData(chunkId, position)
					const velocities = this.getComponentData(chunkId, velocity)
					const size = this.getChunkSize(chunkId)
					for (let i = 0; i < size; i++) {
						expect(positions.x[i]).toBe(123)
						expect(positions.y[i]).toBe(456)
						expect(velocities.x[i]).toBe(7)
						expect(velocities.y[i]).toBe(8)
						verifiedCount++
					}
				}
				expect(verifiedCount).toBe(countToCreate)
			})
		})
		describe('Entity Command Buffer: Advanced & Edge Cases', () => {
			it('should correctly apply a set command to an entity that is also moving in the same frame', () => {
				cleanup()
				// 1. Setup
				const entity = ecs.createEntity({
					position: { x: 1, y: 1 },
					velocity: { x: 1, y: 1 },
					testEntityTag: {},
				})
				flush()

				expect(this.getEntityLocation(entity)).toBeDefined()
				expect(ecs.getComponent(entity, 'position').x).toBe(1)

				// 2. Action: Queue a structural change (add) and a data change (set) in the same frame.
				this.addComponent(entity, this.compile({ isPooled: {} }))
				this.setComponent(entity, this.compile({ position: { x: 100, y: 100 } }))

				// 3. Flush to execute commands.
				flush()

				// 4. Verification
				// The entity should have moved to a new archetype with 'isPooled'.
				expect(ecs.hasComponent(entity, 'isPooled')).toBe(true)
				// It should still have velocity.
				expect(ecs.hasComponent(entity, 'velocity')).toBe(true)
				// The 'setComponent' command should have been correctly applied to the entity in its new location.
				const pos = ecs.getComponent(entity, 'position')
				expect(pos).toEqual({ x: 100, y: 100 })
			})

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
				const payload = this.compile('test_prefab', {
					overrides: {
						position: { x: 123, y: 456 },
					},
				})
				this.instantiate(payload, 1)
				flush()

				const instantiatedEntity = this.instantiateQuery.getSingleEntity()
				expect(instantiatedEntity).toBeDefined()

				const pos = ecs.getComponent(instantiatedEntity, 'position')
				expect(pos).toEqual({ x: 123, y: 456 })
			})

			it('should correctly handle data alignment for mixed data types', () => {
				cleanup()
				// This component tests multiple alignment boundaries in sequence.
				const initialData = {
					val_u8_1: 1,
					val_f64: 123.456,
					val_u16: 2,
					val_f32: 789.012,
					val_i32: -3,
					val_u8_2: 4,
				}
				const payload = this.compile({
					alignmentTestComponent: initialData,
				})

				// The main test is that this does not throw a RangeError during serialization or deserialization.
				expect(() => this.instantiate(payload, 1)).not.toThrow()
				expect(() => this.flush()).not.toThrow()

				// Also verify the data made it through correctly to be sure.
				const query = this.getQuery({ with: [alignmentTestComponent] })
				const entityId = query.getSingleEntity()
				expect(entityId).toBeDefined()
				const data = ecs.getComponent(entityId, 'alignmentTestComponent')

				expect(data.val_u8_1).toBe(initialData.val_u8_1)
				expect(data.val_f64).toBe(initialData.val_f64)
				expect(data.val_u16).toBe(initialData.val_u16)
				// f32 has precision loss
				expect(data.val_f32).toBeCloseTo(initialData.val_f32, 4)
				expect(data.val_i32).toBe(initialData.val_i32)
				expect(data.val_u8_2).toBe(initialData.val_u8_2)
			})
		})

		describe('Entity Command Buffer: Chunk & Memory Integrity', () => {
			it('should not create zombie chunks after destroyEntitiesInChunk', () => {
				cleanup()

				// --- 1. Setup: Create enough entities to fill a chunk ---
				const basePayload = {
					position: {},
					testEntityTag: {},
				}
				const archetypeId = this.compile(basePayload).archetypeId
				const bytesPerEntity = entityManager.getBytesPerEntityInArchetype(archetypeId)
				const entitiesPerChunk = Math.max(16, Math.floor(16384 / bytesPerEntity))

				const creationPayload = this.compile(basePayload, { count: entitiesPerChunk })
				this.instantiate(creationPayload, entitiesPerChunk)
				flush()

				// --- 2. Get the chunk to be destroyed ---
				const chunkId = this.creationQuery.getChunks()[0]
				expect(chunkId).toBeDefined()
				expect(entityStore.chunkSizes[chunkId]).toBe(entitiesPerChunk)

				// --- 3. The Test: Destroy all entities in the chunk ---
				this.destroyEntitiesInChunk(chunkId)
				flush()

				// --- 4. Assertions ---
				expect(entityStore.freeChunkIds.includes(chunkId)).toBe(true, 'Chunk ID should be on the free list')
				expect(entityStore.chunkMetadata[chunkId]).toBe(undefined, 'Chunk metadata should be undefined')

				let isStillLinked = false
				let currentChunkId = entityStore.archetypeHeadChunkIds[archetypeId]
				while (currentChunkId !== 0) {
					if (currentChunkId === chunkId) {
						isStillLinked = true
						break
					}
					currentChunkId = entityStore.chunkNextInArchetype[currentChunkId]
				}
				expect(isStillLinked).toBe(false, 'Destroyed chunk should be unlinked from its archetype')
			})

			it('should correctly re-initialize metadata when recycling a chunk for a different archetype', () => {
				cleanup()

				const basePayloadA = { position: {}, testEntityTag: {} }
				const archetypeIdA = this.compile(basePayloadA).archetypeId
				const componentsInA = entityManager.getComponentTypeIDsForArchetype(archetypeIdA, this.componentTypesScratch)
				const bytesPerEntityA = entityManager.getBytesPerEntityInArchetype(archetypeIdA)
				const entitiesPerChunkA = Math.max(16, Math.floor(16384 / bytesPerEntityA))

				const payloadA = this.compile(basePayloadA, { count: entitiesPerChunkA })
				this.instantiate(payloadA, entitiesPerChunkA)
				flush()

				const queryA = this.getQuery({ with: [position, testEntityTag] })
				const chunkToRecycleId = queryA.getChunks()[0]
				expect(chunkToRecycleId).toBeDefined()
				expect(entityStore.chunkArchetypeDirtyVersions[chunkToRecycleId].length).toBe(componentsInA)

				this.destroyEntitiesInChunk(chunkToRecycleId)

				const payloadB = this.compile({ velocity: {}, rotation: {}, testEntityTag: {} })
				const archetypeIdB = payloadB.archetypeId
				const componentsInB = entityManager.getComponentTypeIDsForArchetype(archetypeIdB, this.componentTypesScratch)
				expect(componentsInB).not.toBe(componentsInA)

				this.instantiate(payloadB, 1)
				flush()

				const queryB = this.getQuery({ with: [velocity, rotation, testEntityTag] })
				expect(queryB.count).toBe(1)
				const recycledChunkId = queryB.getChunks()[0]
				expect(recycledChunkId).toBe(chunkToRecycleId, 'The same chunk ID should be recycled')
				expect(entityStore.chunkArchetypeDirtyVersions[recycledChunkId].length).toBe(componentsInB)
			})

			it('should correctly recycle a chunk in the same frame it was freed', () => {
				cleanup()

				const basePayload = { position: {}, testEntityTag: {} }
				const archetypeId = this.compile(basePayload).archetypeId
				const bytesPerEntity = entityManager.getBytesPerEntityInArchetype(archetypeId)
				const entitiesPerChunk = Math.max(16, Math.floor(16384 / bytesPerEntity))

				const creationPayload = this.compile(basePayload, { count: entitiesPerChunk })
				this.instantiate(creationPayload, entitiesPerChunk)
				flush()

				const chunkToDestroyId = this.creationQuery.getChunks()[0]
				expect(chunkToDestroyId).toBeDefined()

				this.destroyEntitiesInChunk(chunkToDestroyId)
				this.instantiate(creationPayload, 1)
				flush()

				expect(this.creationQuery.count).toBe(1)
				const newChunkId = this.creationQuery.getChunks()[0]
				expect(newChunkId).toBe(chunkToDestroyId)
				expect(entityStore.chunkArchetypeDirtyVersions[newChunkId]).toBeInstanceOf(Uint32Array)
				expect(this.getChunkSize(newChunkId)).toBe(1)
			})

			it('should zero-out recycled chunk memory to prevent data corruption', () => {
				cleanup()

				const { trackedTestComponent, componentB, componentC } = ecs.getComponentIDs()
				const basePayloadA = { trackedTestComponent: { value: 123 }, componentB: {} }
				const payloadB = this.compile({ trackedTestComponent: { value: 0 }, componentC: {} })
				const archetypeIdA = this.compile(basePayloadA).archetypeId
				const bytesPerEntityA = entityManager.getBytesPerEntityInArchetype(archetypeIdA)
				const entitiesPerChunkA = Math.max(16, Math.floor(16384 / bytesPerEntityA))

				const payloadA = this.compile(basePayloadA, { count: entitiesPerChunkA })
				this.instantiate(payloadA, entitiesPerChunkA)
				this.flush()

				const queryA = this.getQuery({ with: [trackedTestComponent, componentB] })
				const chunkToRecycleId = queryA.getChunks()[0]

				this.destroyEntitiesInChunk(chunkToRecycleId)
				this.flush()

				this.instantiate(payloadB, 1)
				this.flush()

				const queryB = this.getQuery({ with: [trackedTestComponent, componentC] })
				const recycledChunkId = queryB.getChunks()[0]
				const trackedCompData_Recycled = this.getComponentData(recycledChunkId, trackedTestComponent)
				expect(trackedCompData_Recycled.value[0]).toBe(0, 'Stale data from recycled chunk was not cleared.')
			})
		})

		describe('Entity Command Buffer: State Mask Integration', () => {

			it('should automatically set the initial state mask on deferred creation', () => {
				cleanup()

				// 1. Defer creation of an entity with a specific initial state.
				const payload = this.compile({
					lifecycleState: { state: LIFECYCLE.SPAWNING }, 
					//! would also need a test without overrides to test most basic - to default behaviour.
				})
				this.instantiate(payload, 1)
				flush()

				// 2. Verification
				const query = this.getQuery({ with: [lifecycleState] })
				const entityId = query.getSingleEntity()
				expect(entityId).toBeDefined()

				const location = this.getEntityLocation(entityId)
				const isSpawningSet = this.isBitSet(isSpawningMaskId, location.chunkId, location.indexInChunk)
				const isActiveSet = this.isBitSet(isActiveMaskId, location.chunkId, location.indexInChunk)

				expect(isSpawningSet).toBe(true, 'isSpawning mask should be set on creation')
				expect(isActiveSet).toBe(false, 'isActive mask should not be set on creation')
			})

			it('should automatically set the default state mask on deferred creation without overrides', () => {
				cleanup()

				// The schema for lifecycleState defaults to ACTIVE (1).
				// We create an entity with the component but provide no data, relying on schema defaults.
				const payload = this.compile({
					lifecycleState: {},
				})
				this.instantiate(payload, 1)
				flush()

				// Verification
				const query = this.getQuery({ with: [lifecycleState] })
				const entityId = query.getSingleEntity()
				expect(entityId).toBeDefined()

				const location = this.getEntityLocation(entityId)
				const isActiveSet = this.isBitSet(isActiveMaskId, location.chunkId, location.indexInChunk)

				expect(isActiveSet).toBe(true, 'isActive mask should be set on creation from schema default')
			})

			it('should automatically update state masks on deferred setComponent', () => {
				cleanup()

				// 1. Create an entity in the ACTIVE state.
				const creationPayload = this.compile({
					lifecycleState: { state: LIFECYCLE.ACTIVE },
				})
				this.instantiate(creationPayload, 1)
				flush()

				const entityId = this.getQuery({ with: [lifecycleState] }).getSingleEntity()
				const location = this.getEntityLocation(entityId)

				// Verify initial state
				expect(this.isBitSet(isActiveMaskId, location.chunkId, location.indexInChunk)).toBe(
					true,
					'Initial state should be ACTIVE',
				)

				// 2. Defer a state change using setComponent.
				const setPayload = this.compile({
					lifecycleState: { state: LIFECYCLE.DYING },
				})
				this.setComponent(entityId, setPayload)
				flush()

				// 3. Verification
				const finalLocation = this.getEntityLocation(entityId) // Location might have changed if archetype did, but not in this case.
				expect(this.isBitSet(isActiveMaskId, finalLocation.chunkId, finalLocation.indexInChunk)).toBe(
					false,
					'isActive mask should be cleared after setComponent',
				)
				expect(this.isBitSet(isDyingMaskId, finalLocation.chunkId, finalLocation.indexInChunk)).toBe(
					true,
					'isDying mask should be set after setComponent',
				)
			})

			it('should automatically set state mask on deferred addComponent', () => {
				cleanup()

				// 1. Create an entity without the lifecycleState component.
				const entityId = ecs.createEntity({ testEntityTag: {} })
				flush()

				// 2. Defer adding the component with a specific state.
				const addPayload = this.compile({ lifecycleState: { state: LIFECYCLE.POOLED } })
				this.addComponent(entityId, addPayload)
				flush()

				// 3. Verification
				const finalLocation = this.getEntityLocation(entityId)
				expect(this.isBitSet(isPooledMaskId, finalLocation.chunkId, finalLocation.indexInChunk)).toBe(true, 'isPooled mask should be set after addComponent')
			})

			it('should preserve state masks during a bulk structural change', () => {
				cleanup()

				// 1. Create two batches of entities with different initial states.
				const activePayload = this.compile({ lifecycleState: { state: LIFECYCLE.ACTIVE } }, { count: 5 })
				const spawningPayload = this.compile({ lifecycleState: { state: LIFECYCLE.SPAWNING } }, { count: 5 })
				this.instantiate(activePayload, 5)
				this.instantiate(spawningPayload, 5)
				flush()

				// 2. Verify initial state.
				const activeQuery = this.getQuery({ with: [lifecycleState] }) // A query to get all of them.
				const allEntities = activeQuery.getChunks().flatMap(chunkId => Array.from(this.getEntities(chunkId).slice(0, this.getChunkSize(chunkId))))
				expect(allEntities.length).toBe(10)

				const activeEntities = allEntities.filter(id => this.isBitSet(isActiveMaskId, this.getEntityLocation(id).chunkId, this.getEntityLocation(id).indexInChunk))
				const spawningEntities = allEntities.filter(id => this.isBitSet(isSpawningMaskId, this.getEntityLocation(id).chunkId, this.getEntityLocation(id).indexInChunk))
				expect(activeEntities.length).toBe(5, 'Should have 5 active entities initially')
				expect(spawningEntities.length).toBe(5, 'Should have 5 spawning entities initially')

				// 3. Defer a bulk structural change that moves all entities.
				const addPayload = this.compile({ testEntityTag: {} })
				this.addComponentsToEntities(allEntities, addPayload)
				flush()

				// 4. Verification: Check that the states were preserved in their new locations.
				const finalActiveCount = activeEntities.filter(id => this.isBitSet(isActiveMaskId, this.getEntityLocation(id).chunkId, this.getEntityLocation(id).indexInChunk)).length
				const finalSpawningCount = spawningEntities.filter(id => this.isBitSet(isSpawningMaskId, this.getEntityLocation(id).chunkId, this.getEntityLocation(id).indexInChunk)).length

				expect(finalActiveCount).toBe(5, 'Active masks should be preserved after bulk move')
				expect(finalSpawningCount).toBe(5, 'Spawning masks should be preserved after bulk move')
				// Also check that they moved.
				expect(this.getQuery({ with: [testEntityTag] }).count).toBe(10)
			})

			it('should automatically fire a "modified" event on deferred setComponent', () => {
				cleanup()

				// 2. Create an entity with the trackable component, managing versions manually for the test.
				const lastVersionBeforeCreation = ecs.systemManager.gameLoop.globalVersion
				const creationVersion = lastVersionBeforeCreation + 1
				const creationPayload = this.compile({ trackedTestComponent: { value: 1.0 } })
				this.instantiate(creationPayload, 1)
				flush(creationVersion)

				const entityId = this.getQuery({ with: [trackedTestComponent] }).getSingleEntity()
				const location = this.getEntityLocation(entityId)
				const scratchBuffer = this.createScratchBuffer()

				// 3. Verify it is dirty initially.
				let dirtyCount = this.getDirty(location.chunkId, trackedTestComponent, lastVersionBeforeCreation, creationVersion, scratchBuffer)
				expect(dirtyCount).toBe(1, 'Entity should be dirty on creation')

				// 4. Defer a setComponent command, again managing versions.
				const lastVersionBeforeSet = ecs.systemManager.gameLoop.globalVersion
				const setVersion = lastVersionBeforeSet + 1
				const setPayload = this.compile({ trackedTestComponent: { value: 2.0 } })
				this.setComponent(entityId, setPayload)
				flush(setVersion)

				// 5. Verification: The entity should now be dirty for the tick it was changed.
				dirtyCount = this.getDirty(location.chunkId, trackedTestComponent, lastVersionBeforeSet, setVersion, scratchBuffer)
				expect(dirtyCount).toBe(1, 'Entity should be marked dirty after setComponent')
			})
		})

		describe('EntityMaskManager: Immediate Mode & Edge Cases', () => {
			it('should automatically set initial state mask on ecs.createEntity', () => {
				cleanup()
				const entityId = ecs.createEntity({ lifecycleState: { state: LIFECYCLE.SPAWNING } })
				const location = this.getEntityLocation(entityId)
				expect(this.isBitSet(isSpawningMaskId, location.chunkId, location.indexInChunk)).toBe(true)
			})

			it('should automatically update state masks on ecs.setComponent', () => {
				cleanup()
				const entityId = ecs.createEntity({ lifecycleState: { state: LIFECYCLE.ACTIVE } })
				let location = this.getEntityLocation(entityId)
				expect(this.isBitSet(isActiveMaskId, location.chunkId, location.indexInChunk)).toBe(true)

				ecs.setComponent(entityId, 'lifecycleState', { state: LIFECYCLE.DYING })

				location = this.getEntityLocation(entityId)
				expect(this.isBitSet(isActiveMaskId, location.chunkId, location.indexInChunk)).toBe(false)
				expect(this.isBitSet(isDyingMaskId, location.chunkId, location.indexInChunk)).toBe(true)
			})

			it('should NOT update state masks on ecs.setComponentsSilent', () => {
				cleanup()
				const entityId = ecs.createEntity({ lifecycleState: { state: LIFECYCLE.ACTIVE } })
				let location = this.getEntityLocation(entityId)
				expect(this.isBitSet(isActiveMaskId, location.chunkId, location.indexInChunk)).toBe(true)

				ecs.setComponentsSilent(entityId, { lifecycleState: { state: LIFECYCLE.DYING } })

				location = this.getEntityLocation(entityId)
				expect(this.isBitSet(isActiveMaskId, location.chunkId, location.indexInChunk)).toBe(true, 'isActive mask should NOT be cleared by silent set')
				expect(this.isBitSet(isDyingMaskId, location.chunkId, location.indexInChunk)).toBe(false, 'isDying mask should NOT be set by silent set')
			})

			it('should automatically set state mask on ecs.addComponent', () => {
				cleanup()
				const entityId = ecs.createEntity({ testEntityTag: {} })
				ecs.addComponent(entityId, 'lifecycleState', { state: LIFECYCLE.POOLED })
				const location = this.getEntityLocation(entityId)
				expect(this.isBitSet(isPooledMaskId, location.chunkId, location.indexInChunk)).toBe(true)
			})

			it('should clear state masks when the defining component is removed', () => {
				cleanup()
				const entityId = ecs.createEntity({ lifecycleState: { state: LIFECYCLE.ACTIVE } })
				const oldLocation = this.getEntityLocation(entityId)
				expect(this.isBitSet(isActiveMaskId, oldLocation.chunkId, oldLocation.indexInChunk)).toBe(true)

				// This causes an archetype move.
				ecs.removeComponent(entityId, 'lifecycleState')

				// The entity is now in a new chunk that does not have the lifecycleState component,
				// so the mask should not be allocated for it.
				const newLocation = this.getEntityLocation(entityId)
				expect(newLocation.chunkId).not.toBe(oldLocation.chunkId)

				// Attempting to query the mask for the new chunk should fail gracefully.
				// The underlying masksByChunk array will be undefined for this maskId/chunkId combo.
				// The API is designed to throw a TypeError in this case to signal a developer error.
				expect(() => this.isBitSet(isActiveMaskId, newLocation.chunkId, newLocation.indexInChunk)).toThrow(TypeError)
			})

			it('should handle being set twice without issue', () => {
				cleanup()
				const entityId = ecs.createEntity({ lifecycleState: { state: LIFECYCLE.SPAWNING } })
				const location = this.getEntityLocation(entityId)
				const scratch = this.createScratchBuffer()

				// The first set happens automatically on creation.
				let count = this.getIndicesFromMask(isSpawningMaskId, location.chunkId, scratch)
				expect(count).toBe(1)

				// Manually set it again.
				this.setBit(isSpawningMaskId, location.chunkId, location.indexInChunk)

				// The count should still be 1.
				count = this.getIndicesFromMask(isSpawningMaskId, location.chunkId, scratch)
				expect(count).toBe(1)

				// Clearing it should work correctly.
				this.clearBit(isSpawningMaskId, location.chunkId, location.indexInChunk)
				count = this.getIndicesFromMask(isSpawningMaskId, location.chunkId, scratch)
				expect(count).toBe(0)
			})
		})

		// Run all the defined tests.
		await testManager.runAllTests()
	}

	destroy() {
		testManager.clear()
	}
}