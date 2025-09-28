const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs, testManager} = engine.getManagers()

const { entityManager, queryManager, prefabManager, systemManager } = ecs

const { describe, it, expect } = await import(`${PATH_MANAGERS}/TestManager/TestAPI.js`)

const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

/**
 * A simple configuration object to enable or disable specific command buffer tests.
 */
const testConfig = {
	//true / false
	runCreateEntityTest: true,
	runDestroyEntityTest: true,
	runAddComponentTest: true,
	runRemoveComponentTest: true,
	runSetComponentDataTest: true,
	runInstantiateTest: true,
	runCreateEntitiesTest: true,
	runQueryBasedModificationTest: false, // This test is no longer valid.
}

/**
 * A system dedicated to testing the functionality of the low-level CommandBuffer.
 * It runs a suite of self-contained tests for each API method during its `init` phase.
 */
export class CommandBufferTestSystem {
	constructor() {
		this.systemManager = systemManager

		const { position, velocity, testEntityTag } = ecs.getTypeIDs()
		Object.assign(this, { position, velocity, testEntityTag })

		// Create queries for verification steps.
		// All queries now require the TestEntityTag to ensure they only match test entities.
		this.creationQuery = queryManager.getQuery({
			with: [position, testEntityTag],
			without: [velocity],
		})

		this.instantiateQuery = queryManager.getQuery({
			with: [position, velocity, testEntityTag],
		})

		// --- Pre-compile payloads for tests ---
		this.addComponentPayload = payloadCompiler.compileComponent(this.velocity, { x: 5, y: 5 }).payload
		this.setVelocityPayload = payloadCompiler.compileComponent(this.velocity, { x: 999, y: -999 }).payload
		this.setPositionPayload = payloadCompiler.compileComponent(this.position, { x: 100, y: 100 }).payload

		// Payload for generational entity tests
		this.generationalTestVelocityPayload = payloadCompiler.compileComponent(this.velocity, { x: 999, y: 999 })
	}

	async init() {
		// Preload the specific prefab needed for the instantiate test.
		await prefabManager.preload(['test_prefab'])

		const flush = () => {
			this.systemManager.commandBufferExecutor.execute(this.commands)
		}

		describe('Command Buffer API', () => {
			// --- Test 1: createEntity ---
			if (testConfig.runCreateEntityTest) {
				it('should create an entity with components via createEntity', () => {
					const { payload } = payloadCompiler.compileEntity({
						position: { x: 10, y: 20},
						testEntityTag: {},
					})
					this.commands.createEntity(payload)
					flush()

					let createdEntity
					for (const chunk of this.creationQuery.iter()) {
						createdEntity = chunk.entities[0]
						break
					}

					expect(createdEntity).not.toBe(undefined)

					const pos = ECS.getComponent(createdEntity, 'position')
					expect(pos).toEqual({ x: 10, y: 20})

					this.commands.destroyEntity(createdEntity)
					flush()
				})
			}

			// --- Test 2: destroyEntity ---
			if (testConfig.runDestroyEntityTest) {
				it('should destroy an entity via destroyEntity', () => {
					const entity = entityManager.createEntity()

					this.commands.destroyEntity(entity)
					flush()
					expect(entityManager.isEntityActive(entity)).toBe(false)
				})
			}

			// --- Test 3: addComponent ---
			if (testConfig.runAddComponentTest) {
				it('should add a component to an entity via addComponent', () => {
					const entity = ECS.createEntity({
						position: { x: 1, y: 1 },
						testEntityTag: {}, // Add the tag for isolation
					})

					this.commands.addComponent(entity, this.addComponentPayload)
					flush()
					expect(ECS.hasComponent(entity, 'velocity')).toBe(true)

					// Verify the component data was written correctly.
					const vel = ECS.getComponent(entity, 'velocity')
					expect(vel).toEqual({ x: 5, y: 5 })
					this.commands.destroyEntity(entity)
					flush()
				})
			}

			// --- Test 4: removeComponent ---
			if (testConfig.runRemoveComponentTest) {
				it('should remove a component from an entity via removeComponent', () => {
					const entity = ECS.createEntity({
						position: {},
						velocity: { x: 5, y: 5 },
						testEntityTag: {},
					})
					this.commands.removeComponent(entity, this.velocity)
					flush()
					expect(ECS.hasComponent(entity, `velocity`)).toBe(false)
					this.commands.destroyEntity(entity)
					flush()
				})
			}

			// --- Test 5: setComponentData ---
			if (testConfig.runSetComponentDataTest) {
				it('should set component data on an entity via setComponentData', () => {
					const entity = ECS.createEntity({
						position: { x: 50, y: 50 },
						testEntityTag: {},
					})

					this.commands.setComponentData(entity, this.setPositionPayload)
					flush()
					const pos = ECS.getComponent(entity, 'position')
					expect(pos).toEqual({ x: 100, y: 100 })
					this.commands.destroyEntity(entity)
					flush()
				})
			}

			// --- Test 6: instantiate ---
			if (testConfig.runInstantiateTest) {
				it('should instantiate an entity from a prefab with overrides', () => {
					if (!prefabManager.getPrefabData('test_prefab')) {
						console.log(
							"%c[CB Test] Skipping Instantiate Test: Prefab 'test_prefab' not found or preloaded.",
							'color: gray'
						)
						return
					}
					// Compile the prefab payload with overrides.
					const { payload } = payloadCompiler.compileEntity('test_prefab', { position: { x: 123, y: 456 } })

					this.commands.instantiate(payload, 0)
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
					this.commands.destroyEntity(instantiatedEntity)
					flush()
				})
			}

			// --- Test 8 & 9: Batch and Query-Based Modifications (Isolated) ---
			if (testConfig.runCreateEntitiesTest && testConfig.runQueryBasedModificationTest) {
				// This test is disabled because query-based command buffer operations have been removed.
			}
		})

		describe('Command Buffer (Generational Entity IDs - ABA Problem)', () => {
			let entityA_ID, entityA_Index, entityA_Generation
			let entityB_ID

			it('Step 1: should create an initial entity (A)', () => {
				entityA_ID = ECS.createEntity({ position: { x: 1, y: 1 } })
				entityA_Index = Number(entityA_ID & 0xffffffffn)
				entityA_Generation = Number(entityA_ID >> 32n)

				expect(entityManager.isEntityActive(entityA_ID)).toBe(true)
				expect(entityA_Generation).toBeGreaterThanOrEqual(0)
			})

			it('Step 2: should queue a modification and destruction for entity A', () => {
				this.commands.addComponent(entityA_ID, this.generationalTestVelocityPayload.payload)
				this.commands.destroyEntity(entityA_ID)
				expect(entityManager.isEntityActive(entityA_ID)).toBe(true)
			})

			it('Step 3: should execute the destruction command first', () => {
				flush()
				expect(entityManager.isEntityActive(entityA_ID)).toBe(false)
			})

			it('Step 4: should create a new entity (B) that reuses the index of A', () => {
				entityB_ID = ECS.createEntity({ position: { x: 2, y: 2 } })
				const entityB_Index = Number(entityB_ID & 0xffffffffn)
				const entityB_Generation = Number(entityB_ID >> 32n)

				expect(entityManager.isEntityActive(entityB_ID)).toBe(true)
				expect(entityB_Index).toBe(entityA_Index)
				expect(entityB_Generation).toBe(entityA_Generation + 1)
			})

			it('Step 5: should process the stale addComponent command and ignore it', () => {
				flush()
				const hasVelocity = ECS.hasComponent(entityB_ID, 'Velocity')
				expect(hasVelocity).toBe(false)
			})

			it('Step 6: should clean up the test entity', () => {
				const destroyed = ECS.destroyEntity(entityB_ID)
				expect(destroyed).toBe(true)
			})
		})

		describe('Command Buffer (Generational IDs - Advanced Scenarios)', () => {
			it('should ignore a stale setComponentData command', () => {
				// --- 1. Setup ---
				const entityA_ID = ECS.createEntity({ position: { x: 1, y: 1 } })

				// --- 2. Defer Commands ---
				this.commands.setComponentData(entityA_ID, this.setPositionPayload)
				this.commands.destroyEntity(entityA_ID)

				// --- 3. Flush & Recycle ---
				flush() // Destroys entity A
				const entityB_ID = ECS.createEntity({ position: { x: 2, y: 2 } })

				// --- 4. Flush Stale Command ---
				flush() // Processes the stale setComponentData command

				// --- 5. Verification ---
				const posB = ECS.getComponent(entityB_ID, 'Position')
				expect(posB.x).toBe(2) // Should not be 100
				expect(posB.y).toBe(2) // Should not be 100

				// Cleanup
				ECS.destroyEntity(entityB_ID)
			})

			it('should ignore a stale removeComponent command', () => {
				// --- 1. Setup ---
				const entityA_ID = ECS.createEntity({ position: { x: 1, y: 1 }, velocity: { x: 1, y: 1 } })

				// --- 2. Defer Commands ---
				this.commands.removeComponent(entityA_ID, this.velocity)
				this.commands.destroyEntity(entityA_ID)

				// --- 3. Flush & Recycle ---
				flush() // Destroys entity A
				const entityB_ID = ECS.createEntity({ position: { x: 2, y: 2 }, velocity: { x: 2, y: 2 } })

				// --- 4. Flush Stale Command ---
				flush() // Processes the stale removeComponent command

				// --- 5. Verification ---
				const hasVelocity = ECS.hasComponent(entityB_ID, 'Velocity')
				expect(hasVelocity).toBe(true) // Should not have been removed

				// Cleanup
				ECS.destroyEntity(entityB_ID)
			})

			it('should handle multiple recycle cycles correctly', () => {
				// --- 1. Setup ---
				const entityA_ID = ECS.createEntity({ position: { x: 1, y: 1 } })
				const entityA_Index = Number(entityA_ID & 0xffffffffn)

				// --- 2. Defer command for original entity ---
				this.commands.addComponent(entityA_ID, this.generationalTestVelocityPayload.payload)
				this.commands.destroyEntity(entityA_ID)

				// --- 3. First Cycle ---
				flush() // Destroys A
				const entityB_ID = ECS.createEntity({ position: { x: 2, y: 2 } })
				ECS.destroyEntity(entityB_ID) // Destroy B immediately
				const entityC_ID = ECS.createEntity({ position: { x: 3, y: 3 } })

				// --- 4. Flush Stale Command & Verify ---
				flush() // Processes the original stale command for A
				expect(ECS.hasComponent(entityC_ID, 'Velocity')).toBe(false)
				ECS.destroyEntity(entityC_ID)
			})
		})

		// Run all the defined tests.
		testManager.runAllTests()
	}
}
