export const MPSC_QUEUE_CAPACITY = 8192 // MUST be a power of two.

if ((MPSC_QUEUE_CAPACITY & (MPSC_QUEUE_CAPACITY - 1)) !== 0) {
	throw new Error('[MPSCQueue] MPSC_QUEUE_CAPACITY must be a power of two.')
}

const MPSC_QUEUE_MASK = MPSC_QUEUE_CAPACITY - 1

// To prevent false sharing, pointers must reside on different cache lines (64 bytes).
// A BigInt64 is 8 bytes. So we place pointers at an index offset of 8 (8*8=64 bytes).
const STATE_HEAD_OFFSET = 0 // Consumer-only: Points to the next item to be read.
const STATE_TAIL_OFFSET = 8 // Producer/Consumer: Points to the last committed item.
const STATE_WRITE_CLAIM_OFFSET = 16 // Producer-only: Atomically incremented to claim a write slot.

/**
 * A lock-free, fixed-size, Multi-Producer, Single-Consumer (MPSC) queue.
 * This queue is designed for high-throughput scenarios where many threads (producers)
 * need to send data to a single thread (the consumer).
 *
 * It uses a circular buffer and atomic operations on head/tail pointers to ensure
 * thread safety without locks.
 *
 * ### Correctness Note: 64-bit Pointers for Overflow Safety
 *
 * The `head`, `tail`, and `write_claim` pointers are unbounded and cumulative, meaning they are
 * never reset and increment for the lifetime of the application. Using a standard 32-bit
 * integer (`Int32Array`) for these pointers would introduce a critical overflow bug.
 *
 * **Calculation for 32-bit Overflow:**
 * - Max value of a signed 32-bit integer: 2,147,483,647
 * - At a high but plausible workload of 300,000 jobs/sec (5k jobs @ 60fps):
 * - Time to overflow: 2.147B / 300,000 ≈ 7,158 seconds ≈ **2 hours**
 *
 * An overflow would cause pointer comparisons to fail, leading to memory corruption as the
 * queue wraps around and overwrites unread data.
 *
 * **The 64-bit Solution:**
 * This implementation uses `BigInt64Array` for its state pointers.
 * - Max value of a signed 64-bit integer: 9,223,372,036,854,775,807
 * - At the same workload of 300,000 jobs/sec:
 * - Time to overflow: 9.22 quintillion / 300,000 / (3600*24*365.25) ≈ **974,590 years**
 *
 * Using 64-bit integers makes the queue unconditionally safe from pointer overflow for the
 * practical lifetime of any application. This is a correctness fix, not over-engineering.
 */
export class MPSCQueue {
	/**
	 * @param {object} options
	 * @param {SharedArrayBuffer} options.stateSAB - A SAB for head, tail, and write claim pointers, padded for cache alignment.
	 * @param {SharedArrayBuffer} options.dataSAB - A SAB to hold the queue's data.
	 */
	constructor({ stateSAB, dataSAB }) {
		if (dataSAB.byteLength / 4 !== MPSC_QUEUE_CAPACITY) {
			throw new Error('[MPSCQueue] dataSAB size does not match MPSC_QUEUE_CAPACITY.')
		}
		this.state = new BigInt64Array(stateSAB) // Use BigInt64Array to prevent overflow.
		this.data = new Uint32Array(dataSAB)
		this.capacity = BigInt(MPSC_QUEUE_CAPACITY) // Store capacity as BigInt for comparisons.
		this.mask = MPSC_QUEUE_MASK
	}

	/**
	 * Pushes a value onto the queue. Can be called by any producer thread.
	 * @param {number} value - The value to push (e.g., a job ID).
	 */
	push(value) {
		// 1. Atomically claim a slot to write to. `add` returns the *previous* value.
		const writeIndex = Atomics.add(this.state, STATE_WRITE_CLAIM_OFFSET, 1n)

		// 2. Wait until the slot is available. This only happens if the queue is full.
		// We use Atomics.wait to sleep efficiently instead of spin-waiting.
		let head = Atomics.load(this.state, STATE_HEAD_OFFSET)
		while (writeIndex >= head + this.capacity) {
			// The queue is full. Wait for the consumer to drain it and change the head pointer.
			// The third argument is the value we expect `head` to have. If it has already
			// changed, `wait` returns immediately. This handles the race condition where
			// the consumer drains the queue between our `load` and `wait` calls.
			Atomics.wait(this.state, STATE_HEAD_OFFSET, head)
			// After waking up, we must re-load the head to check the condition again.
			head = Atomics.load(this.state, STATE_HEAD_OFFSET)
		}

		// 3. Write the data to the claimed slot. This can be a non-atomic store, but we
		// use Atomics.store for consistency and to be explicit about shared memory access.
		const physicalIndex = Number(writeIndex & BigInt(this.mask))
		Atomics.store(this.data, physicalIndex, value)

		// 4. Publish the write by updating the tail pointer. This must be done in order.
		// A producer that claimed slot N must wait for slot N-1 to be published
		// before it can publish slot N. We use a CAS loop to serialize producers.
		while (Atomics.compareExchange(this.state, STATE_TAIL_OFFSET, writeIndex, writeIndex + 1n) !== writeIndex) {
			// Another producer with an earlier index is still writing and hasn't updated the tail yet.
			// We spin and wait for them to update the tail to our `writeIndex`.
		}
	}

	/**
	 * Drains all available items from the queue into an array.
	 * Should only be called by the single consumer thread.
	 * @param {Uint32Array} outArray - A Uint32Array to write the drained items into.
	 * @returns {number} The number of items drained from the queue.
	 */
	drain(outArray) {
		// 1. Load the current head and tail pointers.
		// `head` is only modified by this thread (the consumer).
		// `tail` is modified by producer threads, so we must use an atomic load.
		const head = Atomics.load(this.state, STATE_HEAD_OFFSET)
		const tail = Atomics.load(this.state, STATE_TAIL_OFFSET)

		const count = Number(tail - head) // Convert BigInt result to Number for array operations.
		if (count <= 0) {
			return 0
		}

		if (!(outArray instanceof Uint32Array)) {
			throw new Error('[MPSCQueue.drain] outArray must be a Uint32Array to support efficient block copies.')
		}
		if (outArray.length < count) {
			throw new Error(`[MPSCQueue.drain] outArray is too small. Required: ${count}, Available: ${outArray.length}`)
		}

		const headIndex = Number(head & BigInt(this.mask))

		// 2. Perform one or two block copies depending on whether the data wraps around the buffer.
		if (headIndex + count > this.capacity) {
			const firstPartCount = Number(this.capacity) - headIndex
			const secondPartCount = count - firstPartCount

			outArray.set(this.data.subarray(headIndex, headIndex + firstPartCount))
			outArray.set(this.data.subarray(0, secondPartCount), firstPartCount)
		} else {
			// Data is in a single contiguous block
			outArray.set(this.data.subarray(headIndex, headIndex + count))
		}

		// 3. "Commit" the read by updating the head pointer.
		// This makes the drained slots available to producers.
		const newHead = head + BigInt(count)
		Atomics.store(this.state, STATE_HEAD_OFFSET, newHead)

		// 4. Notify any producers that are waiting because the queue was full.
		// This wakes them up from their `Atomics.wait` call in `push()`.
		Atomics.notify(this.state, STATE_HEAD_OFFSET, Infinity)

		return count
	}

	/**
	 * Resets the queue by setting head and tail to 0.
	 * Should only be called when no other threads are accessing the queue.
	 */
	reset() {
		Atomics.store(this.state, STATE_HEAD_OFFSET, 0n)
		Atomics.store(this.state, STATE_TAIL_OFFSET, 0n)
		Atomics.store(this.state, STATE_WRITE_CLAIM_OFFSET, 0n)
	}

	/**
	 * Returns the number of items currently in the queue.
	 * This should be considered an approximation in a multi-threaded context,
	 * as producers can be adding items concurrently.
	 * @returns {number}
	 */
	size() {
		const head = Atomics.load(this.state, STATE_HEAD_OFFSET)
		const tail = Atomics.load(this.state, STATE_TAIL_OFFSET)
		return Number(tail - head)
	}
}
