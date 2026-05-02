// Constants from the plan
const SLOT_STATE = {
	EMPTY: 0,
	OCCUPIED: 1,
	DELETED: 2,
}

const SLOT_LAYOUT = {
	STATE_OFFSET: 0, // u8
	VALUE_OFFSET: 2, // u16
	KEY_OFFSET: 8, // 32 bytes (Uint8Array), must be 8-byte aligned for BigUint64Array views.
	SLOT_SIZE: 64, // Padded to cache line size
}

const METADATA_LAYOUT = {
	SIZE_OFFSET: 0, // u32
	CAPACITY_OFFSET: 4, // u32
}

const DEFAULT_INITIAL_CAPACITY = 256
const RESIZE_LOAD_FACTOR = 0.7

/**
 * A high-performance, thread-safe hash map for archetype lookups, implemented in a SharedArrayBuffer.
 * It uses open addressing with linear probing.
 *
 * ### Memory and Performance
 *
 * - **`capacity`**: The total number of available slots in the map. This is configured at creation.
 * - **`size`**: The number of currently occupied slots (i.e., the number of unique archetypes).
 * - **Load Factor**: The ratio of `size / capacity`. When this exceeds `RESIZE_LOAD_FACTOR` (e.g., 0.7),
 *   the map triggers a resize operation.
 *
 * ### Resizing
 *
 * Resizing is an expensive, "stop-the-world" operation. It allocates a new, larger `SharedArrayBuffer`
 * and re-hashes every single existing element to place it correctly in the new buffer. This is
 * fundamental to how hash maps work, as an element's slot is calculated via `hash % capacity`.
 *
 * **To avoid runtime stutters, it is highly recommended to pre-allocate a `capacity` large enough
 * to accommodate the expected number of unique archetypes in your game.** A good rule of thumb is
 * to set the capacity to `1.5x` the expected number of archetypes to maintain a healthy load factor.
 *
 * ### Space-Time Trade-off
 *
 * A lower load factor (i.e., a larger, more sparsely populated map) is better for performance.
 * - **Pros of Over-allocation**: Fewer hash collisions, leading to shorter linear probe chains. This makes
 *   `lookup()` and `insert()` operations faster and more consistent.
 * - **Cons of Over-allocation**: Increased memory usage.
 *
 * For this engine, prioritizing lookup speed is more important than minimizing memory, so a generous
 * initial capacity is a good trade-off.
 *
 * The buffer has a 64-byte header for metadata, followed by the slots.
 * Header: [size (u32), capacity (u32), ...padding]
 */
export class SharedArchetypeHashMap {
	/**
	 * @param {SharedArrayBuffer | { initialCapacity?: number, workerManager?: import('../../Managers/WorkerManager/WorkerManager.js').WorkerManager }} optionsOrBuffer
	 * @param {function} hashFn The hash function (e.g., h64 from xxhash-wasm) that takes a Uint8Array and returns a BigInt.
	 */
	constructor(optionsOrBuffer, hashFn) {
		if (typeof hashFn !== 'function') {
			throw new Error('SharedArchetypeHashMap requires a hash function.')
		}
		this.hashFn = hashFn

		if (optionsOrBuffer instanceof SharedArrayBuffer) {
			this._initFromBuffer(optionsOrBuffer)
		} else {
			const { initialCapacity = DEFAULT_INITIAL_CAPACITY, workerManager } = optionsOrBuffer
			this.workerManager = workerManager
			this._initNew(initialCapacity)
		}
	}

	_initNew(capacity) {
		// The first 64 bytes are reserved for metadata: [size, capacity, ...padding]
		const bufferSize = SLOT_LAYOUT.SLOT_SIZE + capacity * SLOT_LAYOUT.SLOT_SIZE
		const buffer = new SharedArrayBuffer(bufferSize)
		this._initFromBuffer(buffer)

		// Initialize metadata
		this.capacity = capacity
		this.size = 0
	}

	_initFromBuffer(buffer) {
		this.buffer = buffer
		// Metadata view (first slot)
		this.metaView = new Uint32Array(this.buffer, 0, 2) // [size, capacity]
		// Data views
		this.u8View = new Uint8Array(this.buffer)
		this.u16View = new Uint16Array(this.buffer)
	}

	/** The number of items currently in the map. */
	get size() {
		return Atomics.load(this.metaView, METADATA_LAYOUT.SIZE_OFFSET / 4)
	}

	/** @private */
	set size(value) {
		Atomics.store(this.metaView, METADATA_LAYOUT.SIZE_OFFSET / 4, value)
	}

	/** The total number of slots available in the map. */
	get capacity() {
		return Atomics.load(this.metaView, METADATA_LAYOUT.CAPACITY_OFFSET / 4)
	}

	/** @private */
	set capacity(value) {
		Atomics.store(this.metaView, METADATA_LAYOUT.CAPACITY_OFFSET / 4, value)
	}

	_getSlotBase(slotIndex) {
		// Offset by 1 slot to account for metadata header
		return (slotIndex + 1) * SLOT_LAYOUT.SLOT_SIZE
	}

	_hash(key) {
		// The key is a BigUint64Array. The hash function is designed to take it directly.
		return this.hashFn(key)
	}

	/**
	 * Internal method to find the slot for a key.
	 * This is the core of the open addressing logic.
	 * @param {BigUint64Array} key The key to find.
	 * @param {boolean} forInsert If true, finds a slot for insertion (can be a deleted slot).
	 * @returns {{slotIndex: number, found: boolean}}
	 * @private
	 */
	_findSlot(key, forInsert = false) {
		const hash = this._hash(key)
		const capacity = this.capacity
		if (capacity === 0) return { slotIndex: -1, found: false }

		let slotIndex = Number(hash % BigInt(capacity))
		let firstDeleted = -1

		const startIndex = slotIndex

		while (true) {
			const slotBase = this._getSlotBase(slotIndex)
			const state = this.u8View[slotBase + SLOT_LAYOUT.STATE_OFFSET]

			if (state === SLOT_STATE.EMPTY) {
				return { slotIndex: forInsert && firstDeleted !== -1 ? firstDeleted : slotIndex, found: false }
			}

			if (state === SLOT_STATE.DELETED) {
				if (forInsert && firstDeleted === -1) {
					firstDeleted = slotIndex
				}
			} else if (state === SLOT_STATE.OCCUPIED) {
				const existingKey = new BigUint64Array(this.buffer, slotBase + SLOT_LAYOUT.KEY_OFFSET, 4)
				let keysMatch = true
				for (let i = 0; i < 4; i++) {
					if (key[i] !== existingKey[i]) {
						keysMatch = false
						break
					}
				}
				if (keysMatch) {
					return { slotIndex, found: true }
				}
			}

			slotIndex = (slotIndex + 1) % capacity
			if (slotIndex === startIndex) {
				return { slotIndex: forInsert && firstDeleted !== -1 ? firstDeleted : -1, found: false }
			}
		}
	}

	insert(key, value) {
		// Check if adding one more element will exceed the load factor.
		if (this.workerManager && (this.size + 1) / this.capacity > RESIZE_LOAD_FACTOR) {
			this._resize()
		}

		const { slotIndex, found } = this._findSlot(key, true)

		if (slotIndex === -1) {
			this._resize()
			return this.insert(key, value)
		}

		const slotBase = this._getSlotBase(slotIndex)

		if (found) {
			this.u16View[(slotBase + SLOT_LAYOUT.VALUE_OFFSET) / 2] = value
		} else {
			const keyView = new Uint8Array(key.buffer, key.byteOffset, key.byteLength)
			this.u8View[slotBase + SLOT_LAYOUT.STATE_OFFSET] = SLOT_STATE.OCCUPIED
			this.u16View[(slotBase + SLOT_LAYOUT.VALUE_OFFSET) / 2] = value
			this.u8View.set(keyView, slotBase + SLOT_LAYOUT.KEY_OFFSET)
			this.size++
		}
	}

	lookup(key) {
		const { slotIndex, found } = this._findSlot(key)
		if (found) {
			const slotBase = this._getSlotBase(slotIndex)
			return this.u16View[(slotBase + SLOT_LAYOUT.VALUE_OFFSET) / 2]
		}
		return undefined
	}

	delete(key) {
		const { slotIndex, found } = this._findSlot(key)
		if (found) {
			const slotBase = this._getSlotBase(slotIndex)
			this.u8View[slotBase + SLOT_LAYOUT.STATE_OFFSET] = SLOT_STATE.DELETED
			this.size--
			return true
		}
		return false
	}

	_resize() {
		const oldCapacity = this.capacity
		const oldBuffer = this.buffer
		const oldU8View = new Uint8Array(oldBuffer)

		// 1. Allocate new, larger buffer directly
		const newCapacity = oldCapacity * 2
		const newBufferSize = SLOT_LAYOUT.SLOT_SIZE + newCapacity * SLOT_LAYOUT.SLOT_SIZE
		const newBuffer = new SharedArrayBuffer(newBufferSize)

		// 2. Create views for the new buffer
		const newMetaView = new Uint32Array(newBuffer, 0, 2)
		const newU8View = new Uint8Array(newBuffer)
		const newU16View = new Uint16Array(newBuffer)

		// 3. Initialize new metadata
		Atomics.store(newMetaView, METADATA_LAYOUT.CAPACITY_OFFSET / 4, newCapacity)
		let newSize = 0

		// 4. Re-hash and insert all items from old buffer to new buffer
		for (let i = 0; i < oldCapacity; i++) {
			const oldSlotBase = (i + 1) * SLOT_LAYOUT.SLOT_SIZE
			const state = oldU8View[oldSlotBase + SLOT_LAYOUT.STATE_OFFSET]

			if (state === SLOT_STATE.OCCUPIED) {
				const value = new Uint16Array(oldBuffer, oldSlotBase + SLOT_LAYOUT.VALUE_OFFSET, 1)[0]
				const keyBytes = new Uint8Array(oldBuffer, oldSlotBase + SLOT_LAYOUT.KEY_OFFSET, 32)
				const key = new BigUint64Array(keyBytes.buffer, keyBytes.byteOffset, 4)

				// --- Manual insert logic into new buffer ---
				const hash = this._hash(key)
				let newSlotIndex = Number(hash % BigInt(newCapacity))

				while (true) {
					const newSlotBase = (newSlotIndex + 1) * SLOT_LAYOUT.SLOT_SIZE
					// The new buffer is guaranteed to be zero-filled, so its state is EMPTY.
					if (newU8View[newSlotBase + SLOT_LAYOUT.STATE_OFFSET] === SLOT_STATE.EMPTY) {
						newU8View[newSlotBase + SLOT_LAYOUT.STATE_OFFSET] = SLOT_STATE.OCCUPIED
						newU16View[(newSlotBase + SLOT_LAYOUT.VALUE_OFFSET) / 2] = value
						newU8View.set(keyBytes, newSlotBase + SLOT_LAYOUT.KEY_OFFSET)
						newSize++
						break // Move to next item in old buffer
					}
					newSlotIndex = (newSlotIndex + 1) % newCapacity
				}
			}
		}

		Atomics.store(newMetaView, METADATA_LAYOUT.SIZE_OFFSET / 4, newSize)
		this._initFromBuffer(newBuffer)
		this.workerManager.broadcast('archetype-map-resize', {
			archetypeMapBuffer: this.buffer,
		})
	}

	clear() {
		this.size = 0
		this.u8View.fill(0, SLOT_LAYOUT.SLOT_SIZE) // Clear only slots, not metadata
	}

	*values() {
		const capacity = this.capacity
		for (let i = 0; i < capacity; i++) {
			const slotBase = this._getSlotBase(i)
			const state = this.u8View[slotBase + SLOT_LAYOUT.STATE_OFFSET]
			if (state === SLOT_STATE.OCCUPIED) {
				yield this.u16View[(slotBase + SLOT_LAYOUT.VALUE_OFFSET) / 2]
			}
		}
	}
}