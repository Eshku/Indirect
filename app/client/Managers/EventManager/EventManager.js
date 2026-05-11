/**
 * @file Defines the InstantEventChannel primitive and the EventManager to manage them.
 * NOTE: For better organization, InstantEventChannel could be moved to its own file.
 */
import { eventChannels } from '@managers/EventManager/eventChannels.manifest.js'

// A map from schema type strings to their corresponding TypedArray constructors.
const TYPED_ARRAY_MAP = {
	f64: Float64Array,
	f32: Float32Array,
	u32: Uint32Array,
	i32: Int32Array,
	u16: Uint16Array,
	i16: Int16Array,
	u8: Uint8Array,
	i8: Int8Array,
	u64: BigUint64Array,
	i64: BigInt64Array,
}

/**
 * Represents a single, schema-driven, zero-latency event channel.
 * It uses a Structure-of-Arrays (SoA) layout backed by SharedArrayBuffers
 * to allow for high-performance, parallel-safe event emission.
 *
 * --- Memory Layout & Lifecycle ---
 *
 * An `InstantEventChannel` pre-allocates large, fixed-size `TypedArray` buffers for each
 * property in its schema. The number of events written in a frame is tracked by a single
 * atomic `count` property.
 *
 * The `clear()` method, called at the end of each frame, **only resets this `count` to 0**.
 * It does **not** clear the underlying data arrays. The old data is simply treated as
 * "garbage" and will be overwritten by new events in the next frame. This is a highly
 * efficient "reset" that avoids the cost of zeroing out large memory blocks.
 *
 * An instance of this class can be shared between the main thread and workers.
 *
 * --- Concurrency & Performance Design ---
 *
 * 1.  **Correctness with CAS Loops**: For atomic batch operations (`pushBatchAtomic`), a
 *     Compare-and-Swap (CAS) loop is used to reserve a block of indices. A simpler
 *     `Atomics.add` approach is unsafe because it would increment the counter even if the
 *     batch overflows. This would create "ghost events" - slots that are counted but contain
 *     no valid data. A reader system would then process these slots, which could contain
 *     `0` or `0n`, leading to bugs if those are valid values in the application logic. The
 *     CAS loop is a "check-then-commit" pattern that guarantees the `count` always reflects
 *     the number of valid, written events. The same logic applies to `pushAtomic`.
 *
 * 2.  **False Sharing Prevention**: The `count` variable for each channel is the point of
 *     highest contention. Since each channel's counter is in its own `SharedArrayBuffer`,
 *     the risk of false sharing between counters of *different* channels is negligible, as
 *     the memory allocator is unlikely to place them contiguously.
 *
 * 3.  **Structure-of-Arrays (SoA) Batching**: The `pushBatch` methods require data in an
 *     SoA format (e.g., `{ prop1: [...], prop2: [...] }`). This allows for a highly
 *     optimized bulk copy using `TypedArray.set()`, which is significantly faster than
 *     copying element by element from an Array-of-Structures (AoS) format.
 *
 * 4.  **Allocation-Free API**: The single-push methods (`push`, `pushAtomic`) use the `arguments`
 *     object internally instead of rest parameters (`...values`). This avoids allocating a new
 *     temporary array on every call, reducing garbage collection pressure in hot paths.
 */

//! It is developer's responsibility to ensure reads follow only after writes and never in parallel (reads + writes)
//! That is by design.

//! classic double-buffer implementation will be added eventually, so both approaches avaliable.

export class InstantEventChannel {
	/**
	 * @param {object} schema - The schema defining the event structure, e.g., { amount: 'f32', target: 'u64' }.
	 * @param {number} [capacity=1024] - The maximum number of events that can be stored per frame.
	 */
	constructor(schema, capacity = 1024) {
		this.schema = schema
		this.capacity = capacity
		this.propertyKeys = Object.keys(schema)
		// The atomic counter for the number of events. Stored in a SAB so it can be shared.
		this.count = new Uint32Array(new SharedArrayBuffer(4))

		// The `buffers` object holds the SoA data arrays.
		// This is the object that reader systems will interact with directly for data.
		this.buffers = {}

		for (const propKey of this.propertyKeys) {
			const type = schema[propKey]
			const constructor = TYPED_ARRAY_MAP[type]
			if (!constructor) {
				throw new Error(`InstantEventChannel: Unsupported type "${type}" in event schema.`)
			}
			// Buffers must be in SABs to be accessible from workers.
			const buffer = new SharedArrayBuffer(capacity * constructor.BYTES_PER_ELEMENT)
			this.buffers[propKey] = new constructor(buffer)
		}
	}

	/**
	 * Resets the event counter to 0.
	 * This is called at the end of the frame's logic phase.
	 */
	clear() {
		// This is only ever called by the main thread when workers are idle. A non-atomic write is safe and faster.
		this.count[0] = 0
	}

	/**
	 * Gets the current number of events in the channel.
	 * This is a non-atomic read, safe as long as no writes happens in parallel with read.
	 * @returns {number}
	 */
	getCount() {
		return this.count[0]
	}

	/**
	 * Atomically gets the current number of events in the channel.
	 * @returns {number}
	 */
	getCountAtomic() {
		return Atomics.load(this.count, 0)
	}

	/**
	 * Gets the raw Structure-of-Arrays buffers for direct, high-performance reading.
	 * @returns {object}
	 */
	getBuffers() {
		return this.buffers
	}

	/**
	 * Creates a reusable, allocation-free batch object for this event channel.
	 * This is a developer-experience helper to avoid manual TypedArray creation in systems.
	 * @param {number} capacity - The number of events the batch object should be able to hold.
	 * @returns {object} An SoA object with pre-allocated TypedArrays, e.g., { prop1: new Float32Array(capacity), ... }.
	 */
	createBatch(capacity) {
		const batch = {}
		for (const propKey of this.propertyKeys) {
			const type = this.schema[propKey]
			const constructor = TYPED_ARRAY_MAP[type]
			batch[propKey] = new constructor(capacity)
		}
		return batch
	}

	/**
	 * Pushes a single event to the channel. This is NOT thread-safe and should
	 * only be used when you can guarantee single-threaded writes to this channel.
	 * The order of values must match the order of properties in the schema.
	 * @param  {...any} values - The primitive values for the event.
	 */
	push(/*...values*/) {
		const index = this.count[0]
		if (index >= this.capacity) {
			console.warn(`InstantEventChannel for schema is full. Dropping event.`)
			return
		}
		this.count[0]++
		// Write the data into the reserved slot.
		for (let i = 0; i < this.propertyKeys.length; i++) {
			const propKey = this.propertyKeys[i]
			this.buffers[propKey][index] = arguments[i]
		}
	}

	/**
	 * Atomically pushes a single event to the channel. Safe for parallel writes.
	 * The order of values must match the order of properties in the schema.
	 * @param  {...any} values - The primitive values for the event.
	 */
	pushAtomic(/*...values*/) {
		let currentCount
		let newCount

		// Use a CAS loop to safely reserve a slot. This is race-condition-safe.
		do {
			currentCount = Atomics.load(this.count, 0)
			newCount = currentCount + 1

			if (newCount > this.capacity) {
				// Not enough space.
				console.warn(`InstantEventChannel for schema is full. Dropping event.`)
				return
			}
		} while (Atomics.compareExchange(this.count, 0, currentCount, newCount) !== currentCount)

		const index = currentCount
		// Write the data into the reserved slot.
		for (let i = 0; i < this.propertyKeys.length; i++) {
			const propKey = this.propertyKeys[i]
			this.buffers[propKey][index] = arguments[i]
		}
	}

	/**
	 * Pushes a batch of events to the channel. This is NOT thread-safe and should
	 * only be used when you can guarantee single-threaded writes to this channel.
	 * @param {object} eventBatchSoA - An object where keys are property names and values are TypedArrays of data.
	 * @param {number} count - The number of events to push from the batch.
	 */
	pushBatch(eventBatchSoA, count) {
		if (count === 0) return

		const startIndex = this.count[0]
		if (startIndex + count > this.capacity) {
			console.warn(`InstantEventChannel for schema is full. Dropping batch of ${count} events.`)
			return
		}

		this.count[0] += count

		// Perform a highly optimized bulk copy for each property array.
		for (const propKey of this.propertyKeys) {
			const sourceArray = eventBatchSoA[propKey]
			if (sourceArray) {
				this.buffers[propKey].set(sourceArray.subarray(0, count), startIndex)
			} else {
				console.warn(`pushBatch: Missing property array for "${propKey}" in event batch. Data will be zeroed.`)
			}
		}
	}

	/**
	 * Atomically pushes a batch of events to the channel. This is more efficient
	 * than calling `push` in a loop due to fewer atomic operations.
	 * The batch must be in a Structure-of-Arrays (SoA) format.
	 * @param {object} eventBatchSoA - An object where keys are property names and values are TypedArrays of data.
	 * @param {number} count - The number of events to push from the batch.
	 */
	pushBatchAtomic(eventBatchSoA, count) {
		if (count === 0) return

		let currentCount
		let newCount

		// Use a CAS loop to safely reserve a block of indices. This is race-condition-safe
		// and prevents the "wasted space" issue where the counter is incremented even if
		// the batch doesn't fit, which would lead to readers processing invalid "ghost" events.
		do {
			currentCount = Atomics.load(this.count, 0)
			newCount = currentCount + count

			if (newCount > this.capacity) {
				// Not enough space for the entire batch.
				console.warn(`InstantEventChannel for schema is full. Dropping batch of ${count} events.`)
				return
			}
		} while (Atomics.compareExchange(this.count, 0, currentCount, newCount) !== currentCount)

		const startIndex = currentCount
		// Perform a highly optimized bulk copy for each property array.
		for (const propKey of this.propertyKeys) {
			const sourceArray = eventBatchSoA[propKey]
			if (sourceArray) {
				this.buffers[propKey].set(sourceArray.subarray(0, count), startIndex)
			} else {
				// If a property is missing from the batch, its data in the channel will be
				// undefined/zero for this batch. This is a developer error, so we warn.
				console.warn(`pushBatchAtomic: Missing property array for "${propKey}" in event batch.`)
			}
		}
	}
}

/**
 * A main-thread-only manager responsible for creating, tracking, and clearing all
 * InstantEventChannel instances based on a static manifest. It also provides
 * the shareable data payload for worker initialization.
 */
class EventManager {
	async init(engine) {
		this.channelsByName = new Map()
		this.channelRegistry = {}
		this.workerManager = engine.workerManager

		// Register all event channels from the static manifest.
		for (const name in eventChannels) {
			const config = eventChannels[name]
			const channel = this._registerChannel(name, config.schema, config.capacity)
			this.channelRegistry[name] = channel
		}

		Object.freeze(this.channelRegistry)

		// Provide the shareable event channel data to the WorkerManager so it can
		// be included in the initial payload for all new workers.
		this.workerManager.addInitialResource('eventChannels', this.getSharedData())
	}

	/**
	 * Internal method to create and register a channel.
	 * @param {string} name - A unique name for the channel.
	 * @param {object} schema - The schema for the event data.
	 * @param {number} [capacity=1024] - The channel's capacity.
	 * @private
	 */
	_registerChannel(name, schema, capacity = 1024) {
		if (this.channelsByName.has(name)) {
			throw new Error(`EventManager: A channel with the name "${name}" already exists.`)
		}
		if (!schema) {
			throw new Error(`EventManager: Schema must be provided to create channel "${name}".`)
		}
		const channel = new InstantEventChannel(schema, capacity)
		this.channelsByName.set(name, channel)
		return channel
	}

	/**
	 * Gathers all shareable channel data for worker initialization.
	 * @returns {object} A serializable object mapping channel names to their buffer objects.
	 */
	getSharedData() {
		const sharedData = {}
		for (const [name, channel] of this.channelsByName.entries()) {
			// The `buffers` object contains the data SABs, and `count` is the counter SAB.
			// Both need to be shared for workers to read and write.
			sharedData[name] = {
				count: channel.count,
				buffers: channel.buffers,
			}
		}
		return sharedData
	}

	/**
	 * Retrieves the read-only registry of all channels, keyed by their camelCase names.
	 * This is the preferred, type-safe way for systems to access channels.
	 * @returns {Object.<string, InstantEventChannel>}
	 */
	getChannels() {
		return this.channelRegistry
	}

	clearAllChannels() {
		for (const channel of this.channelsByName.values()) {
			channel.clear()
		}
	}
}

export const eventManager = new EventManager()
