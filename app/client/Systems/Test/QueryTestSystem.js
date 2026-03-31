const { engine } = await import(`@client/Engine.js`)
const { ecs, testManager } = engine.getManagers()
// Destructure all needed managers from the ecs object
const { entityManager, systemManager } = ecs

const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`);

// Get component type IDs. ComponentA and ComponentB are from other test files but are fine to use.
const { queryTestTag, queryTestToggle, componentA, componentB } = ecs.getComponentIDs();

/**
 * A system dedicated to testing the core functionality and reactivity of the Query system.
 * It verifies that queries correctly track entities as components are added, removed, and as entities are destroyed.
 */
export class QueryTestSystem {
	constructor() {
		// This system needs access to the systemManager to flush the command buffer.
		this.systemManager = systemManager
	}

	async init() {
		// Helper to flush the command buffer and execute all queued commands.
		const flush = () => {
			this.flush()
		}

		// Pre-compile payloads to make tests cleaner and more efficient.
		const togglePayload = this.compile(queryTestToggle, {}).payload

		// A helper to clean up all test entities between tests to ensure isolation.
		const cleanup = () => {
			// This query will find all entities created by this test system.
			const query = this.getQuery({ with: [queryTestTag] })
			for (const chunk of query.iter()) {
				// Use the highly efficient chunk-based destruction command.
				this.destroyEntitiesInChunk(chunk)
			}
			flush()
		}

		describe('Query System', () => {
			describe('Basic `with` and `without` queries', () => {
				it('should correctly count entities based on component presence', () => {
					cleanup()

					// Create one entity with the toggle, one without. Use ComponentA/B as markers.
					this.createEntity(this.compile({ queryTestTag: {}, componentA: {} }).payload)
					this.createEntity(
						this.compile({ queryTestTag: {}, queryTestToggle: {}, componentB: {} }).payload,
					)
					flush()

					const withQuery = this.getQuery({ with: [queryTestTag, queryTestToggle] })
					const withoutQuery = this.getQuery({ with: [queryTestTag], without: [queryTestToggle] })

					expect(withQuery.count).toBe(1)
					expect(withoutQuery.count).toBe(1)

					const entityWithToggle = withQuery.getSingleEntity()
					const entityWithoutToggle = withoutQuery.getSingleEntity()

					expect(entityWithToggle).toBeDefined()
					expect(entityWithoutToggle).toBeDefined()

					// Verify we got the right entities by checking for the marker components.
					expect(ecs.hasComponent(entityWithToggle, 'ComponentB')).toBe(true)
					expect(ecs.hasComponent(entityWithoutToggle, 'ComponentA')).toBe(true)
				})
			})

			describe('Query reactivity to structural changes', () => {
				it('should update when a component is added', () => {
					cleanup()
					const withQuery = this.getQuery({ with: [queryTestTag, queryTestToggle] })
					const withoutQuery = this.getQuery({ with: [queryTestTag], without: [queryTestToggle] })

					const placeholder_e1 = this.createEntity(this.compile({ queryTestTag: {} }).payload)
					flush()

					// Before change
					expect(withQuery.count).toBe(0)
					expect(withoutQuery.count).toBe(1)
					const real_e1 = withoutQuery.getSingleEntity()
					expect(real_e1).toBeDefined()

					// Add component using the real entity ID. Placeholders are only valid
					// for the duration of a single command buffer flush.
					this.addComponent(real_e1, togglePayload)
					flush()

					// After change
					expect(withQuery.count).toBe(1)
					expect(withoutQuery.count).toBe(0)
					expect(withQuery.getSingleEntity()).toBe(real_e1)
				})

				it('should update when a component is removed', () => {
					cleanup()
					const withQuery = this.getQuery({ with: [queryTestTag, queryTestToggle] })
					const withoutQuery = this.getQuery({ with: [queryTestTag], without: [queryTestToggle] })

					this.createEntity(this.compile({ queryTestTag: {}, queryTestToggle: {} }).payload)
					flush()

					// Before change
					expect(withQuery.count).toBe(1)
					expect(withoutQuery.count).toBe(0)
					const real_e1 = withQuery.getSingleEntity()
					expect(real_e1).toBeDefined()

					// Remove component
					this.removeComponent(real_e1, queryTestToggle)
					flush()

					// After change
					expect(withQuery.count).toBe(0)
					expect(withoutQuery.count).toBe(1)
					expect(withoutQuery.getSingleEntity()).toBe(real_e1)
				})

				it('should update when an entity is destroyed', () => {
					cleanup()
					const withQuery = this.getQuery({ with: [queryTestTag, queryTestToggle] })

					this.createEntity(
						this.compile({ queryTestTag: {}, queryTestToggle: {} }).payload,
					)
					flush()

					const real_e1 = withQuery.getSingleEntity()
					expect(withQuery.count).toBe(1)

					this.destroyEntity(real_e1)
					flush()

					expect(withQuery.count).toBe(0)
				})
			})

			describe('`any` query', () => {
				it('should find entities with any of the specified components', () => {
					cleanup()
					const anyQuery = this.getQuery({ with: [queryTestTag], any: [componentA, componentB] })

					// Create entities with different combinations
					this.createEntity(this.compile({ queryTestTag: {}, componentA: {} }).payload)
					this.createEntity(this.compile({ queryTestTag: {}, componentB: {} }).payload)
					this.createEntity(this.compile({ queryTestTag: {} }).payload) // This one should not match
					flush()

					expect(anyQuery.count).toBe(2)
				})
			})

			describe('Query Caching', () => {
				it('should return the same query instance for the same definition', () => {
					const options = { with: [queryTestTag, queryTestToggle], without: [componentA] }
					const q1 = this.getQuery(options)
					const q2 = this.getQuery(options)
					expect(q1).toBe(q2)
				})

				it('should return different query instances for different definitions', () => {
					const q1 = this.getQuery({ with: [componentA] })
					const q2 = this.getQuery({ with: [componentB] })
					const q3 = this.getQuery({ with: [componentA], without: [componentB] })
					expect(q1).not.toBe(q2)
					expect(q1).not.toBe(q3)
					expect(q2).not.toBe(q3)
				})
			})
		})

		await testManager.runAllTests()
	}

	destroy() {
		// On HMR, clear the previously registered tests from the TestManager
		// to prevent duplicate test execution.
		testManager.clear()
	}
}