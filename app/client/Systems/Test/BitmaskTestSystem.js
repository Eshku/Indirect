const { engine } = await import(`@client/Engine.js`)
const { ecs, testManager } = engine.getManagers()
const { entityManager } = ecs
const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`)
const { ChunkView } = await import('@managers/QueryManager/ChunkView.js')
const { entityStore } = await import('@managers/EntityManager/EntityManager.js')

// Use an existing enableable component and a new tag for this test.
// NOTE: You will need to define `bitmaskTestTag: {}` in a component schema file.
const { enableableTestComponent, bitmaskTestTag } = ecs.getComponentIDs()

/**
 * A system dedicated to testing the low-level bitmask operations for
 * enableable components. It verifies both immediate-mode and deferred-mode
 * writes to the bitmask, helping to rule out memory corruption or incorrect
 * bitwise logic as a source of bugs.
 */
export class BitmaskTestSystem {
	init() {
		const flush = () => this.flush()

		const cleanup = () => {
			const query = this.getQuery({ with: [bitmaskTestTag] })
			for (const chunk of query.iter()) {
				this.destroyEntitiesInChunk(chunk)
			}
			flush()
		}

		describe('Component Enable Bitmask', () => {
			// Run cleanup before each test to ensure isolation.
			cleanup()

			it('should correctly toggle bits using immediate-mode writes (chunk.enable/disableComponent)', () => {
				const ENTITY_COUNT = 65 // Cross at least one 32-bit word boundary.
				const { payload } = this.compile({
					enableableTestComponent: {},
					bitmaskTestTag: {},
				})

				for (let i = 0; i < ENTITY_COUNT; i++) {
					this.createEntity(payload)
				}
				flush()

				const query = this.getQuery({ with: [bitmaskTestTag] })
				const chunk = query.getSingleChunk()
				expect(chunk).toBeDefined()
				expect(chunk.size).toBe(ENTITY_COUNT)

				const scratchBuffer = new Uint32Array(chunk.capacity)

				// 1. Verify initial state: all enabled
				expect(chunk.getEnabledIndices(enableableTestComponent, scratchBuffer)).toBe(ENTITY_COUNT)

				// 2. Disable specific indices
				const indicesToDisable = [0, 15, 31, 32, 64]
				for (const index of indicesToDisable) {
					chunk.disableComponent(index, enableableTestComponent)
				}

				// 3. Verify disabled state
				// Check specific indices
				for (let i = 0; i < ENTITY_COUNT; i++) {
					const shouldBeEnabled = !indicesToDisable.includes(i)
					expect(chunk.isComponentEnabled(i, enableableTestComponent)).toBe(
						shouldBeEnabled,
						`Entity at index ${i} should have enabled state: ${shouldBeEnabled}`,
					)
				}

				// Check bulk query
				const enabledCount = chunk.getEnabledIndices(enableableTestComponent, scratchBuffer)
				expect(enabledCount).toBe(ENTITY_COUNT - indicesToDisable.length)
				const enabledIndices = Array.from(scratchBuffer.slice(0, enabledCount))
				for (const disabledIndex of indicesToDisable) {
					expect(enabledIndices.includes(disabledIndex)).toBe(false, `Disabled index ${disabledIndex} should not be in enabled list`)
				}

				// 4. Re-enable one index and verify
				chunk.enableComponent(32, enableableTestComponent)
				expect(chunk.isComponentEnabled(32, enableableTestComponent)).toBe(true)
				expect(chunk.getEnabledIndices(enableableTestComponent, scratchBuffer)).toBe(ENTITY_COUNT - indicesToDisable.length + 1)
			})

			it('should correctly toggle bits using deferred commands (this.enable/disableComponent)', () => {
				cleanup()
				const ENTITY_COUNT = 65
				const placeholderEntities = [] // This array will hold stale placeholder IDs
				const { payload } = this.compile({
					enableableTestComponent: {},
					bitmaskTestTag: {},
				})

				for (let i = 0; i < ENTITY_COUNT; i++) {
					placeholderEntities.push(this.createEntity(payload))
				}
				flush() // This resolves the placeholders and creates the real entities.

				const query = this.getQuery({ with: [bitmaskTestTag] })
				const chunk = query.getSingleChunk()
				expect(chunk).toBeDefined()

				// --- FIX: Get the REAL entity IDs from the chunk after creation ---
				// We must not reuse the placeholder IDs from the `placeholderEntities` array.
				const realEntities = Array.from(chunk.entities.slice(0, chunk.size))
				expect(realEntities.length).toBe(ENTITY_COUNT, 'Should have found all created entities in the chunk')

				// 1. Disable specific entities via deferred commands using their REAL IDs.
				const indicesToDisable = [0, 15, 31, 32, 64]
				// Map the indices in the chunk to the real entity IDs.
				const entitiesToDisable = indicesToDisable.map(i => realEntities[i])
				for (const entityId of entitiesToDisable) {
					this.disableComponent(entityId, enableableTestComponent)
				}
				flush()

				// 2. Verify disabled state
				const scratchBuffer = new Uint32Array(chunk.capacity)
				const enabledCount = chunk.getEnabledIndices(enableableTestComponent, scratchBuffer)
				expect(enabledCount).toBe(ENTITY_COUNT - indicesToDisable.length)

				// 3. Re-enable one entity and verify
				this.enableComponent(realEntities[32], enableableTestComponent)
				flush()
				expect(chunk.isComponentEnabled(32, enableableTestComponent)).toBe(true)
				expect(chunk.getEnabledIndices(enableableTestComponent, scratchBuffer)).toBe(ENTITY_COUNT - indicesToDisable.length + 1)
			})
		})

		// Run all tests
		setTimeout(() => testManager.runAllTests(), 200) // Delay to ensure other systems are ready
	}

	destroy() {
		testManager.clear()
	}
}