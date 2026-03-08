const { engine } = await import(`@client/Engine.js`)
const { ecs, testManager } = engine.getManagers()
const { entityManager } = ecs

const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`)

/**
 * A utility function to deconstruct and log an entity ID for human-readable validation.
 * @param {bigint} id The entity ID.
 * @param {string} label A descriptive label for the log output.
 * @returns {{index: number, generation: number, placeholder: number}} The deconstructed parts of the ID.
 */
function logEntityId(id, label) {
	if (typeof id !== 'bigint' || id < 0n) {
		console.log(`${label}: Invalid ID provided.`)
		return { index: -1, generation: -1, placeholder: -1 }
	}
	const index = Number(id & 0xffffffffn)
	const generation = Number((id >> 32n) & 0x7fffffffn) // 31 bits for generation
	const placeholder = Number(id >> 63n)

	console.log(
		`%c[${label}] %cID: ${id}, %cIndex: ${index}, %cGeneration: ${generation}, %cPlaceholder: ${placeholder}`,
		'font-weight: bold; color: #8af;', // Label style
		'color: #eee;', // ID style
		'color: #5f5;', // Index style
		'color: #f9a;', // Generation style
		'color: #aaa;', // Placeholder style
	)

	return { index, generation, placeholder }
}

/**
 * A system dedicated to testing the generational entity ID mechanism.
 * It runs a suite of self-contained tests that are easy to validate from a human perspective.
 *
 * This test relies on the fact that it runs in a clean environment where no other entities
 * are being created or destroyed simultaneously. This allows us to make predictable assertions
 * about entity indices (e.g., the first entity will have index 1, and a destroyed entity's
 * index will be the next one recycled).
 */
export class GenerationalEntityTestSystem {
	constructor() {
		// No constructor logic needed for this test.
	}

	async init() {
		// This function is async to match the system lifecycle, but all test logic here is synchronous.

		// Since our simple test runner doesn't have `beforeAll`, we'll manually reset the state
		// at the beginning to ensure a clean slate for our index and generation predictions.
		entityManager.destroyAllEntities()

		describe('Generational Entity IDs (Human-Readable Validation)', () => {
			let firstEntityId
			let firstEntityIndex
			let firstEntityGeneration

			it('Step 1: should create an initial entity and verify its generation is 0', () => {
				// We assume the ECS is in a clean state, so the first entity will get the first available index.
				firstEntityId = ecs.createEntity({ position: { x: 1 } })
				const { index, generation, placeholder } = logEntityId(firstEntityId, 'Create Entity A')
				firstEntityIndex = index
				firstEntityGeneration = generation

				expect(entityManager.isEntityActive(firstEntityId)).toBe(true)
				// Assuming a clean slate, the first index is 1.
				expect(index).toBe(1)
				// The first time an index is used, its generation should be 0.
				expect(generation).toBe(0)
				expect(placeholder).toBe(0) // Placeholder bit should not be set.
			})

			it('Step 2: should destroy the entity, making its ID inactive', () => {
				console.log(`%c[Action] Destroying Entity A (ID: ${firstEntityId})`, 'font-weight: bold; color: #f55;')
				const destroyed = ecs.destroyEntity(firstEntityId)

				expect(destroyed).toBe(true)
				expect(entityManager.isEntityActive(firstEntityId)).toBe(false)
			})

			it('Step 3: should create a new entity that reuses the index with an incremented generation', () => {
				// The index from the destroyed entity 'A' is now in the free pool.
				// The next created entity should recycle it.
				const recycledEntityId = ecs.createEntity({ position: { x: 2 } })
				const {
					index: recycledEntityIndex,
					generation: recycledEntityGeneration,
					placeholder,
				} = logEntityId(recycledEntityId, 'Create Entity B (Recycled)')

				expect(entityManager.isEntityActive(recycledEntityId)).toBe(true)
				// Verify the index was reused.
				expect(recycledEntityIndex).toBe(firstEntityIndex)
				// Verify the generation was incremented.
				expect(recycledEntityGeneration).toBe(firstEntityGeneration + 1)
				expect(placeholder).toBe(0)

				// Cleanup for the next test.
				ecs.destroyEntity(recycledEntityId)
			})

			it('Step 4: should correctly handle multiple creation/destruction cycles', () => {
				// This test ensures the generation counter increments correctly over multiple cycles on the same index.
				const entityC_ID = ecs.createEntity({ position: { x: 3 } })
				const { index: entityC_Index, generation: entityC_Generation } = logEntityId(entityC_ID, 'Create Entity C')

				// This should reuse the index from the entity destroyed in the previous test.
				expect(entityC_Index).toBe(firstEntityIndex)
				// The generation should now be 2 (0 -> 1 -> 2).
				expect(entityC_Generation).toBe(firstEntityGeneration + 2)

				ecs.destroyEntity(entityC_ID)
				console.log(`%c[Action] Destroying Entity C (ID: ${entityC_ID})`, 'font-weight: bold; color: #f55;')

				const entityD_ID = ecs.createEntity({ position: { x: 4 } })
				const { generation: entityD_Generation } = logEntityId(entityD_ID, 'Create Entity D')

				expect(entityD_Generation).toBe(firstEntityGeneration + 3)

				ecs.destroyEntity(entityD_ID)
			})
		})

		describe('Generational Entity IDs (LIFO Recycling)', () => {
			it('should recycle indices in Last-In, First-Out (LIFO) order', () => {
				// --- 1. Setup: Create and destroy entities to populate the free list ---
				const entity1 = ecs.createEntity({ position: { x: 1 } }) // index 1 (recycled), gen 4
				const entity2 = ecs.createEntity({ position: { x: 2 } }) // index 2 (new), gen 0
				const entity3 = ecs.createEntity({ position: { x: 3 } }) // index 3 (new), gen 0

				const { index: index1, generation: gen1 } = logEntityId(entity1, 'LIFO Test: Create 1')
				const { index: index2, generation: gen2 } = logEntityId(entity2, 'LIFO Test: Create 2')
				const { index: index3, generation: gen3 } = logEntityId(entity3, 'LIFO Test: Create 3')

				// Destroy in order: 2, then 3. The free list stack should be [1, 3, 2].
				ecs.destroyEntity(entity2)
				console.log(`%c[Action] Destroying LIFO Entity 2 (Index: ${index2})`, 'font-weight: bold; color: #f55;')
				ecs.destroyEntity(entity3)
				console.log(`%c[Action] Destroying LIFO Entity 3 (Index: ${index3})`, 'font-weight: bold; color: #f55;')

				// --- 2. Verification: Create new entities and check recycled indices ---

				// First new entity should recycle index 3 (last one destroyed).
				const newEntityA = ecs.createEntity({ position: { x: 4 } })
				const { index: newIndexA, generation: newGenA } = logEntityId(newEntityA, 'LIFO Test: Recycle A')
				expect(newIndexA).toBe(index3)
				expect(newGenA).toBe(gen3 + 1)

				// Second new entity should recycle index 2.
				const newEntityB = ecs.createEntity({ position: { x: 5 } })
				const { index: newIndexB, generation: newGenB } = logEntityId(newEntityB, 'LIFO Test: Recycle B')
				expect(newIndexB).toBe(index2)
				expect(newGenB).toBe(gen2 + 1)

				// --- 3. Cleanup ---
				ecs.destroyEntity(entity1)
				ecs.destroyEntity(newEntityA)
				ecs.destroyEntity(newEntityB)
			})
		})

		// Run all the defined tests.
		testManager.runAllTests()
	}

	destroy() {
		// On HMR, clear the previously registered tests from the TestManager
		// to prevent duplicate test execution.
		testManager.clear()
	}
}
