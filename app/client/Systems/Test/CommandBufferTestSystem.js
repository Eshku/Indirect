const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { componentManager, entityManager, queryManager, prefabManager, systemManager } = theManager.getManagers()

const { describe, it, expect } = await import(`${PATH_MANAGERS}/TestManager/TestAPI.js`)
const { testManager } = await import(`${PATH_MANAGERS}/TestManager/TestManager.js`)

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
	runQueryBasedModificationTest: true,
}

/**
 * A system dedicated to testing the functionality of the low-level CommandBuffer.
 * It runs a suite of self-contained tests for each API method during its `init` phase.
 */
export class CommandBufferTestSystem {
	constructor() {
		this.systemManager = systemManager

		const { Position, Velocity, TestEntityTag } = componentManager.getTypeIDs()

		this.PositionTypeID = Position
		this.VelocityTypeID = Velocity
		this.TestEntityTagTypeID = TestEntityTag

		// Create queries for verification steps.
		// All queries now require the TestEntityTag to ensure they only match test entities.
		this.creationQuery = queryManager.getQuery({
			with: [Position, TestEntityTag],
			without: [Velocity],
		})

		this.instantiateQuery = queryManager.getQuery({
			with: [Position, Velocity, TestEntityTag],
		})

		// --- Pre-compile payloads for tests ---
		this.addComponentPayload = payloadCompiler.compileComponent(this.VelocityTypeID, { x: 5, y: 5 })
		this.setComponentPayload = payloadCompiler.compileComponent(this.PositionTypeID, { x: 999, y: -999 })
		this.setComponentPayload.mutators.Position.x[0] = 999
		this.setComponentPayload.mutators.Position.y[0] = -999
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
						Position: { x: 10, y: 20 },
						TestEntityTag: {},
					})
					this.commands.createEntity(payload)
					flush()

					let createdEntity
					for (const chunk of this.creationQuery.iter()) {
						createdEntity = chunk.entities[0]
						break
					}

					expect(createdEntity).not.toBe(undefined)

					const pos = ECS.getComponent(createdEntity, 'Position')
					expect(pos).toEqual({ x: 10, y: 20 })

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
						Position: { x: 1, y: 1 },
						TestEntityTag: {}, // Add the tag for isolation
					})

					this.commands.addComponent(entity, this.addComponentPayload.payload)
					flush()
					expect(ECS.hasComponent(entity, 'Velocity')).toBe(true)

					// Verify the component data was written correctly.
					const vel = ECS.getComponent(entity, 'Velocity')
					expect(vel).toEqual({ x: 5, y: 5 })
					this.commands.destroyEntity(entity)
					flush()
				})
			}

			// --- Test 4: removeComponent ---
			if (testConfig.runRemoveComponentTest) {
				it('should remove a component from an entity via removeComponent', () => {
					const entity = ECS.createEntity({
						Position: {},
						Velocity: { x: 5, y: 5 },
						TestEntityTag: {},
					})
					this.commands.removeComponent(entity, this.VelocityTypeID)
					flush()
					expect(ECS.hasComponent(entity, `Velocity`)).toBe(false)
					this.commands.destroyEntity(entity)
					entityManager.destroyEntity(entity)
					flush()
				})
			}

			// --- Test 5: setComponentData ---
			if (testConfig.runSetComponentDataTest) {
				it('should set component data on an entity via setComponentData', () => {
					const entity = ECS.createEntity({
						Position: { x: 50, y: 50 },
						TestEntityTag: {},
					})
					this.commands.setComponentData(entity, this.setComponentPayload.payload)
					flush()
					const pos = ECS.getComponent(entity, 'Position')
					expect(pos).toEqual({ x: 999, y: -999 })
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
					const { payload } = payloadCompiler.compileEntity('test_prefab', { Position: { x: 123, y: 456 } })

					this.commands.instantiate(payload, 0)
					flush()

					let instantiatedEntity
					for (const chunk of this.instantiateQuery.iter()) {
						for (let i = 0; i < chunk.size; i++) {
							const pos = ECS.getComponent(chunk.entities[i], 'Position')
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
				it('creation and all query-based modifications (add, set, remove, destroy)', () => {
					const { QueryTestTag: QueryTestTagTypeID, QueryTestToggle: ComponentToToggleTypeID } =
						componentManager.getTypeIDs()

					// --- COMPILE PAYLOADS ONCE ---
					const { payload: creationPayload } = payloadCompiler.compileEntities({ QueryTestTag: { value: 1 } })
					const { payload: addComponentPayload } = payloadCompiler.compileComponent(ComponentToToggleTypeID, {})
					const { payload: setComponentPayload, mutators: setMutators } = payloadCompiler.compileComponent(
						QueryTestTagTypeID,
						{ value: 777 }
					)

					const addQuery = queryManager.getQuery({ with: [QueryTestTagTypeID], without: [ComponentToToggleTypeID] })
					const removeQuery = queryManager.getQuery({ with: [QueryTestTagTypeID, ComponentToToggleTypeID] })

					// CREATE
					this.commands.createEntities(creationPayload, 10)
					flush()
					expect(addQuery.iter().next().value?.size).toBe(10)

					// ADD
					this.commands.addComponentToQuery(addQuery, addComponentPayload)
					flush()
					expect(removeQuery.iter().next().value?.size).toBe(10)

					// SET
					this.commands.setComponentDataOnQuery(removeQuery, setComponentPayload)
					flush()
					const data = ECS.getComponent(removeQuery.iter().next().value.entities[0], 'QueryTestTag')
					expect(data.value).toBe(777)

					// REMOVE
					this.commands.removeComponentFromQuery(removeQuery, ComponentToToggleTypeID)
					flush()
					expect(addQuery.iter().next().value?.size).toBe(10)

					// DESTROY
					this.commands.destroyEntitiesInQuery(addQuery)
					flush()
					expect(addQuery.iter().next().value).toBe(undefined)
				})
			}
		})

		// Run all the defined tests.
		testManager.runAllTests()
	}
}
