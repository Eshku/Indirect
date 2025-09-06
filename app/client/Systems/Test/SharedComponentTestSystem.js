const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { componentManager, entityManager } = theManager.getManagers()
const { ECS } = await import(`${PATH_CORE}/ECS/ECS.js`)
const { testManager } = await import(`${PATH_CLIENT}/Managers/TestManager/TestManager.js`) // Import testManager
const { describe, it, expect } = await import(`${PATH_CLIENT}/Managers/TestManager/TestAPI.js`)

const { Position, Rarity, Stack } = componentManager.getComponents()

const { componentInterpreter } = await import(`${PATH_MANAGERS}/ComponentManager/ComponentInterpreter.js`)

/**
 * A system to test the "Shared Components as Indirect References" architecture.
 * It verifies that we can query for components with shared data and correctly
 * access both their per-entity and shared properties.
 */
export class SharedComponentTestSystem {
	constructor() {
		// --- Component Type IDs ---
		this.rarityTypeID = componentManager.getComponentTypeID(Rarity)
		this.stackTypeID = componentManager.getComponentTypeID(Stack)

		// --- Manager References ---
		this.componentManager = componentManager // Ensure componentManager is accessible for stringManager

		// --- Test State ---
		this.testEntityIds = [] // To store IDs of all created test entities for comprehensive verification
	}

	init() {
		// This method creates all necessary test entities and then immediately runs the verification tests.
		console.log('%cSharedComponentTestSystem: Initializing and creating test entities...', 'color: yellow')

		// Entity 1: Common, large stack
		// Expected: Unique groupId_A (e.g., {Rarity:'common', Stack.size:64})
		this.testEntityIds.push(
			ECS.createEntity({
				Position: { x: 100, y: 100 },
				Rarity: { value: 'common' },
				Stack: { amount: 10, size: 64 },
			})
		)

		// Entity 2: Rare, large stack (shares `size` with entity 1, but not `value`)
		// Expected: Unique groupId_B (e.g., {Rarity:'rare', Stack.size:64})
		this.testEntityIds.push(
			ECS.createEntity({
				Position: { x: 200, y: 100 },
				Rarity: { value: 'rare' },
				Stack: { amount: 5, size: 64 },
			})
		)

		// Entity 3: Rare, small stack (shares `value` with entity 2, but not `size`)
		// Expected: Unique groupId_C (e.g., {Rarity:'rare', Stack.size:32})
		this.testEntityIds.push(
			ECS.createEntity({
				Position: { x: 300, y: 100 },
				Rarity: { value: 'rare' },
				Stack: { amount: 20, size: 32 },
			})
		)

		// Test Case 4: Common, large stack (identical shared data to Entity 1, different per-entity)
		// Expected: groupId_A (same as Entity 1)
		this.testEntityIds.push(
			ECS.createEntity({
				Position: { x: 400, y: 100 },
				Rarity: { value: 'common' },
				Stack: { amount: 15, size: 64 }, // Different 'amount', same 'size'
			})
		)

		// Test Case 5: Only Rarity (common)
		// Expected: Unique groupId_D (e.g., {Rarity:'common'})
		this.testEntityIds.push(
			ECS.createEntity({
				Position: { x: 500, y: 100 },
				Rarity: { value: 'common' },
			})
		)

		// Test Case 6: Only Stack (large)
		// Expected: Unique groupId_E (e.g., {Stack.size:64})
		this.testEntityIds.push(
			ECS.createEntity({
				Position: { x: 600, y: 100 },
				Stack: { amount: 25, size: 64 },
			})
		)

		// Test Case 7: No shared data (Position only)
		// Expected: groupId_0 (empty shared group)
		this.testEntityIds.push(
			ECS.createEntity({
				Position: { x: 700, y: 100 },
			})
		)

		// Test Case 8: Rare, small stack (identical shared data to Entity 3, different per-entity)
		// Expected: groupId_C (same as Entity 3)
		this.testEntityIds.push(
			ECS.createEntity({
				Position: { x: 800, y: 100 },
				Rarity: { value: 'rare' },
				Stack: { amount: 30, size: 32 }, // Different 'amount', same 'size'
			})
		)

		// Run the verification tests immediately after creating the entities.
		this._runVerificationTests()
	}

	/**
	 * Runs a suite of verification tests using the TestManager.
	 * This method is called once after all test entities have been initialized.
	 */
	_runVerificationTests() {
		describe('Shared Component System', () => {
			// Helper to get the groupId for an entity.
			const getGroupId = entityId => {
				const rarity = ECS.getComponent(entityId, Rarity)
				if (rarity && rarity.hasOwnProperty('groupId')) return rarity.groupId
				const stack = ECS.getComponent(entityId, Stack)
				if (stack && stack.hasOwnProperty('groupId')) return stack.groupId
				return 0 // Default group for entities with no shared components.
			}

			const groupIds = this.testEntityIds.map(id => getGroupId(id))

			it('should assign the same group ID to entities with identical shared data', () => {
				expect(groupIds[0]).toBe(groupIds[3]) // Entity 1 and 4
				expect(groupIds[0]).not.toBe(0)
				expect(groupIds[2]).toBe(groupIds[7]) // Entity 3 and 8
				expect(groupIds[2]).not.toBe(0)
			})

			it('should assign different group IDs to entities with different shared data', () => {
				expect(groupIds[0]).not.toBe(groupIds[1])
				expect(groupIds[1]).not.toBe(groupIds[2])
				expect(groupIds[0]).not.toBe(groupIds[2])
			})

			it('should assign a unique, non-zero group ID for entities with a single shared component', () => {
				expect(groupIds[4]).not.toBe(0) // Entity 5 (Rarity only)
				expect(groupIds[4]).not.toBe(groupIds[0])

				expect(groupIds[5]).not.toBe(0) // Entity 6 (Stack only)
				expect(groupIds[5]).not.toBe(groupIds[0])
				expect(groupIds[5]).not.toBe(groupIds[4])
			})

			it('should assign group ID 0 to entities with no shared components', () => {
				expect(groupIds[6]).toBe(0) // Entity 7
			})

			it('should correctly merge shared and per-entity data', () => {
				const entityId = this.testEntityIds[0] // Entity 1: { Rarity: 'common', Stack.size: 64, amount: 10 }
				const rarity = ECS.getComponent(entityId, Rarity)
				const stack = ECS.getComponent(entityId, Stack)
				const rarityValue = this.componentManager.stringManager.get(rarity.value)

				const mergedData = { rarity: rarityValue, stackSize: stack.size, stackAmount: stack.amount }

				expect(mergedData).toEqual({ rarity: 'common', stackSize: 64, stackAmount: 10 })
			})

			it('should return undefined for components that are not on an entity', () => {
				const entityId = this.testEntityIds[4] // Entity 5: { Rarity: 'common' }
				const stack = ECS.getComponent(entityId, Stack) // Should be undefined

				expect(stack).toBe(undefined)
			})

			it('should ensure all shared components on an entity have the same raw groupId', () => {
				const entityId = this.testEntityIds[0] // Has both Rarity and Stack
				const archetype = entityManager.getArchetypeForEntity(entityId)

				const rarityComp = componentInterpreter.read(entityId, this.rarityTypeID, archetype)
				const stackComp = componentInterpreter.read(entityId, this.stackTypeID, archetype)

				expect(rarityComp.groupId).toBe(stackComp.groupId)
			})
		})

		testManager.runAllTests()
	}
}
