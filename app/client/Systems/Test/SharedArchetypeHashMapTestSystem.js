const { engine } = await import(`@client/Engine.js`)
const { testManager } = engine.getManagers()
const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`)

// Direct imports for the class under test and its dependency
const { SharedArchetypeHashMap } = await import(`@core/DataStructures/SharedArchetypeHashMap.js`)

// Helper to create a random 32-byte key (BigUint64Array)
const createRandomKey = () => {
	const key = new BigUint64Array(4)
	for (let i = 0; i < 4; i++) {
		key[i] = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))
	}
	return key
}

export class SharedArchetypeHashMapTestSystem {
	async init() {
		const { h64Raw } = await xxhash()

		describe('SharedArchetypeHashMap', () => {
			it('should insert and lookup a single value', () => {
				const map = new SharedArchetypeHashMap({ initialCapacity: 16 }, h64Raw)
				const key = createRandomKey()
				const value = 123

				map.insert(key, value)
				const result = map.lookup(key)

				expect(result).toBe(value)
				expect(map.size).toBe(1)
			})

			it('should return undefined for a non-existent key', () => {
				const map = new SharedArchetypeHashMap({ initialCapacity: 16 }, h64Raw)
				const key1 = createRandomKey()
				const key2 = createRandomKey()

				map.insert(key1, 123)

				const result = map.lookup(key2)
				expect(result).toBe(undefined)
			})

			it('should update the value for an existing key', () => {
				const map = new SharedArchetypeHashMap({ initialCapacity: 16 }, h64Raw)
				const key = createRandomKey()

				map.insert(key, 100)
				expect(map.lookup(key)).toBe(100)
				expect(map.size).toBe(1)

				map.insert(key, 200)
				expect(map.lookup(key)).toBe(200)
				expect(map.size).toBe(1) // Size should not increase
			})

			it('should handle hash collisions with linear probing', () => {
				const map = new SharedArchetypeHashMap({ initialCapacity: 4 }, h64Raw)

				// Create two keys that are guaranteed to collide with a small capacity
				const key1 = new BigUint64Array([1n, 0n, 0n, 0n])
				const key2 = new BigUint64Array([2n, 0n, 0n, 0n])
				const key3 = new BigUint64Array([3n, 0n, 0n, 0n])
				const key4 = new BigUint64Array([4n, 0n, 0n, 0n])

				// Mock the hash function to force collisions
				const mockHashFn = key => {
					// All keys hash to slot 0
					return 0n
				}
				map.hashFn = mockHashFn

				map.insert(key1, 1)
				map.insert(key2, 2)
				map.insert(key3, 3)

				expect(map.size).toBe(3)
				expect(map.lookup(key1)).toBe(1)
				expect(map.lookup(key2)).toBe(2)
				expect(map.lookup(key3)).toBe(3)
				expect(map.lookup(key4)).toBe(undefined) // A non-inserted colliding key
			})

			it('should resize when the load factor is exceeded', () => {
				let broadcastCalled = false
				const mockWorkerManager = {
					broadcast: (type, payload) => {
						if (type === 'archetype-map-resize') {
							broadcastCalled = true
							expect(payload.archetypeMapBuffer).toBeInstanceOf(SharedArrayBuffer)
						}
					},
				}

				const initialCapacity = 8
				const map = new SharedArchetypeHashMap(
					{
						initialCapacity,
						workerManager: mockWorkerManager,
					},
					h64Raw,
				)

				// RESIZE_LOAD_FACTOR is 0.7. (5+1)/8 = 0.75. Resize should trigger on the 6th insert.
				const keys = []
				for (let i = 0; i < 6; i++) {
					const key = createRandomKey()
					keys.push(key)
					map.insert(key, i + 1)
				}

				expect(map.size).toBe(6)
				expect(map.capacity).toBe(initialCapacity * 2) // Should have doubled
				expect(broadcastCalled).toBe(true)

				// Verify all old keys are still present after resize
				for (let i = 0; i < 6; i++) {
					expect(map.lookup(keys[i])).toBe(i + 1)
				}
			})

			it('should handle deletion and tombstones correctly', () => {
				const map = new SharedArchetypeHashMap({ initialCapacity: 4 }, h64Raw)

				const key1 = new BigUint64Array([1n, 0n, 0n, 0n])
				const key2 = new BigUint64Array([2n, 0n, 0n, 0n])
				const key3 = new BigUint64Array([3n, 0n, 0n, 0n])

				// Mock hash to force a collision chain: key1, key2, key3 all hash to slot 0
				map.hashFn = key => 0n

				map.insert(key1, 1) // slot 0
				map.insert(key2, 2) // slot 1
				map.insert(key3, 3) // slot 2

				expect(map.size).toBe(3)
				expect(map.lookup(key2)).toBe(2)

				// Delete the middle element of the chain
				const deleted = map.delete(key2)
				expect(deleted).toBe(true)
				expect(map.size).toBe(2)
				expect(map.lookup(key2)).toBe(undefined)

				// Check that we can still find an element after the tombstone
				expect(map.lookup(key3)).toBe(3)

				// Check that we can insert into the tombstone slot
				map.insert(key2, 22) // should reuse the tombstone slot
				expect(map.size).toBe(3)
				expect(map.lookup(key2)).toBe(22)
			})
		})

		await testManager.runAllTests()
	}

	destroy() {
		testManager.clear()
	}
}