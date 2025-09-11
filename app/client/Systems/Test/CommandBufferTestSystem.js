const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { componentManager, entityManager, queryManager, prefabManager, archetypeManager, systemManager } =
	theManager.getManagers()
const { ECS } = await import(`${PATH_CORE}/ECS/ECS.js`)
const { describe, it, expect } = await import(`${PATH_CLIENT}/Managers/TestManager/TestAPI.js`)
const { payloadCompiler } = await import(`${PATH_CLIENT}/Managers/SystemManager/PayloadCompiler.js`)
const { testManager } = await import(`${PATH_CLIENT}/Managers/TestManager/TestManager.js`)

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
					this.commands.createEntity({
						Position: { x: 10, y: 20 },
						TestEntityTag: {},
					})
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
					const entity = entityManager.createEntityWithComponentsByIds(
						new Map([
							[this.PositionTypeID, { x: 1, y: 1 }],
							[this.TestEntityTagTypeID, {}], // Add the tag for isolation
						])
					)

					this.commands.addComponent(entity, this.VelocityTypeID, { x: 5, y: 5 })
					flush()
					expect(entityManager.hasComponent(entity, this.VelocityTypeID)).toBe(true)

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
					const entity = entityManager.createEntityWithComponentsByIds(
						new Map([
							[this.PositionTypeID, {}],
							[this.VelocityTypeID, {}],
							[this.TestEntityTagTypeID, {}],
						])
					)
					this.commands.removeComponent(entity, this.VelocityTypeID)
					flush()
					expect(entityManager.hasComponent(entity, this.VelocityTypeID)).toBe(false)
					this.commands.destroyEntity(entity)
					entityManager.destroyEntity(entity)
					flush()
				})
			}

			// --- Test 5: setComponentData ---
			if (testConfig.runSetComponentDataTest) {
				it('should set component data on an entity via setComponentData', () => {
					const entity = entityManager.createEntityWithComponentsByIds(
						new Map([
							[this.PositionTypeID, { x: 50, y: 50 }],
							[this.TestEntityTagTypeID, {}],
						])
					)
					this.commands.setComponentData(entity, this.PositionTypeID, { x: 999, y: -999 })
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
					const overrides = { Position: { x: 123, y: 456 } }
					this.commands.instantiate('test_prefab', overrides)
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
					const creationPayload = payloadCompiler.compileCreationPayloadFromObject({
						QueryTestTag: { value: 1 },
					})

					const addQuery = queryManager.getQuery({ with: [QueryTestTagTypeID], without: [ComponentToToggleTypeID] })
					const removeQuery = queryManager.getQuery({ with: [QueryTestTagTypeID, ComponentToToggleTypeID] })

					// CREATE
					this.commands.createEntities(creationPayload, 10)
					flush()
					expect(addQuery.iter().next().value?.size).toBe(10)

					// ADD
					this.commands.addComponentToQuery(addQuery, ComponentToToggleTypeID, {})
					flush()
					expect(removeQuery.iter().next().value?.size).toBe(10)

					// SET
					this.commands.setComponentDataOnQuery(removeQuery, QueryTestTagTypeID, { value: 777 })
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
