const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { componentManager, entityManager, queryManager, prefabManager, archetypeManager, systemManager } =
	theManager.getManagers()
const { describe, it, expect } = await import(`${PATH_CLIENT}/Managers/TestManager/TestAPI.js`)
const { testManager } = await import(`${PATH_CLIENT}/Managers/TestManager/TestManager.js`)

const { componentInterpreter } = await import(`${PATH_MANAGERS}/ComponentManager/ComponentInterpreter.js`)

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
	runCreateInArchetypeTest: true,
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

		// Get component classes and TypeIDs for testing
		const { Position, Velocity, TestEntityTag } = componentManager.getComponents()
		this.Position = Position
		this.Velocity = Velocity
		this.TestEntityTag = TestEntityTag
		this.PositionTypeID = componentManager.getComponentTypeID(this.Position)
		this.VelocityTypeID = componentManager.getComponentTypeID(this.Velocity)
		this.TestEntityTagTypeID = componentManager.getComponentTypeID(this.TestEntityTag)

		// Create queries for verification steps.
		// All queries now require the TestEntityTag to ensure they only match test entities.
		this.creationQuery = queryManager.getQuery({
			with: [this.Position, this.TestEntityTag],
			without: [this.Velocity],
		})

		this.instantiateQuery = queryManager.getQuery({
			with: [this.Position, this.Velocity, this.TestEntityTag],
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
					const components = new Map()
					components.set(this.PositionTypeID, { x: 10, y: 20 })
					components.set(this.TestEntityTagTypeID, {}) // Add the isolation tag
					this.commands.createEntity(components)
					flush()

					let createdEntity
					let createdEntityArchetype
					for (const chunk of this.creationQuery.iter()) {
						if (chunk.size > 0) {
							createdEntity = chunk.entities[0]
							createdEntityArchetype = chunk.archetype
							break
						}
					}

					expect(createdEntity).not.toBe(undefined)

					// Verify the component data was written correctly.
					const pos = componentInterpreter.read(createdEntity, this.PositionTypeID, createdEntityArchetype)
					expect(pos).toEqual({ x: 10, y: 20 })

					entityManager.destroyEntity(createdEntity) 
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
					const entity = entityManager.createEntityWithComponentsByIds(new Map([[this.PositionTypeID, { x: 1, y: 1 }]]))
					this.commands.addComponent(entity, this.TestEntityTagTypeID, {}) // Add tag for safety, though not strictly needed here
					this.commands.addComponent(entity, this.VelocityTypeID, { x: 5, y: 5 })
					flush()
					expect(entityManager.hasComponent(entity, this.VelocityTypeID)).toBe(true)

					// Verify the component data was written correctly.
					const vel = componentInterpreter.read(
						entity,
						this.VelocityTypeID,
						entityManager.getArchetypeForEntity(entity)
					)
					expect(vel).toEqual({ x: 5, y: 5 })
					entityManager.destroyEntity(entity) 
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
					const pos = componentInterpreter.read(
						entity,
						this.PositionTypeID,
						entityManager.getArchetypeForEntity(entity)
					)
					expect(pos).toEqual({ x: 999, y: -999 })
					entityManager.destroyEntity(entity) 
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
					const overrides = new Map()
					overrides.set(this.PositionTypeID, { x: 123, y: 456 })
					// The TestEntityTag is now in the prefab itself, so no override is needed.
					this.commands.instantiate('test_prefab', overrides)
					flush()

					let instantiatedEntity
					for (const chunk of this.instantiateQuery.iter()) {
						for (let i = 0; i < chunk.size; i++) {
							const pos = componentInterpreter.read(chunk.entities[i], this.PositionTypeID, chunk.archetype)
							if (pos.x === 123 && pos.y === 456) {
								instantiatedEntity = chunk.entities[i]
								break
							}
						}
						if (instantiatedEntity) break
					}
					expect(instantiatedEntity).not.toBe(undefined)
					entityManager.destroyEntity(instantiatedEntity) 
					flush()
				})
			}

			// --- Test 7: createEntityInArchetype ---
			if (testConfig.runCreateInArchetypeTest) {
				it('should create an entity in a known archetype', () => {
					const targetArchetypeId = archetypeManager.getArchetype([
						this.PositionTypeID,
						this.VelocityTypeID,
						this.TestEntityTagTypeID,
					])
					const initialData = new Map([
						[this.PositionTypeID, { x: 111, y: 222 }],
						[this.VelocityTypeID, { x: 333, y: 444 }],
					])
					this.commands.createEntityInArchetype(targetArchetypeId, initialData)
					flush()

					let foundEntity
					let foundEntityArchetype
					for (const chunk of this.instantiateQuery.iter()) {
						if (chunk.archetype === targetArchetypeId) {
							foundEntity = chunk.entities[0]
							foundEntityArchetype = chunk.archetype
							break
						}
					}
					expect(foundEntity).not.toBe(undefined)

					// Verify the component data was written correctly.
					const pos = componentInterpreter.read(foundEntity, this.PositionTypeID, foundEntityArchetype)
					expect(pos).toEqual({ x: 111, y: 222 })

					entityManager.destroyEntity(foundEntity) 
					flush()
				})
			}

			// --- Test 8 & 9: Batch and Query-Based Modifications (Isolated) ---
			if (testConfig.runCreateEntitiesTest && testConfig.runQueryBasedModificationTest) {
				it('should handle batch creation and query-based modifications', () => {
					const { QueryTestTag, QueryTestToggle } = componentManager.getComponents()
					if (!QueryTestTag || !QueryTestToggle) throw new Error('Test components not found')

					const QueryTestTagTypeID = componentManager.getComponentTypeID(QueryTestTag)
					const ComponentToToggleTypeID = componentManager.getComponentTypeID(QueryTestToggle)

					const addQuery = queryManager.getQuery({ with: [QueryTestTag], without: [QueryTestToggle] })
					const removeQuery = queryManager.getQuery({ with: [QueryTestTag, QueryTestToggle] })

					// CREATE
					this.commands.createEntities(new Map([[QueryTestTagTypeID, { value: 1 }]]), 10)
					flush()
					expect(addQuery.iter().next().value?.size).toBe(10)

					// ADD
					this.commands.addComponentToQuery(addQuery, ComponentToToggleTypeID, {})
					flush()
					expect(removeQuery.iter().next().value?.size).toBe(10)

					// SET
					this.commands.setComponentDataOnQuery(removeQuery, QueryTestTagTypeID, { value: 777 })
					flush()
					const data = componentInterpreter.read(
						removeQuery.iter().next().value.entities[0],
						QueryTestTagTypeID,
						removeQuery.iter().next().value.archetype
					)
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

	/**
	 * The main update loop is now empty, as all tests run once during initialization.
	 */
	update() {
		// This system now runs entirely within its init() method.
		// The update loop is intentionally left empty.
	}
}
