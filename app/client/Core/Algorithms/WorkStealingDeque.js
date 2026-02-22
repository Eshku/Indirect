export const NO_JOB_AVAILABLE = -1

// --- Deque Layout Constants ---
export const DEQUE_CAPACITY = 8192 // Per-thread queue capacity. MUST be a power of two.

// A simple check to enforce the power-of-two requirement for the capacity.
if ((DEQUE_CAPACITY & (DEQUE_CAPACITY - 1)) !== 0) {
	throw new Error('[WorkStealingDeque] DEQUE_CAPACITY must be a power of two.')
}

const DEQUE_MASK = DEQUE_CAPACITY - 1

// To prevent false sharing, head and tail must reside on different cache lines.
// A cache line is typically 64 bytes. A BigInt64 is 8 bytes.
// So, we place the tail pointer at an index offset of 8 (8 * 8 = 64 bytes).
const HEAD_OFFSET = 0
const TAIL_OFFSET = 8
/**
 * A controller for a work-stealing deque that resides in shared memory.
 * This class implements the Chase-Lev double-ended queue algorithm, adapted for the
 * JavaScript environment using `SharedArrayBuffer` and `Atomics`.
 *
 * ### Design Philosophy: A "View" into Shared Memory
 * An instance of this class is not a deque itself, but a "view" or "handle" that
 * provides a structured API for operating on a specific deque's data stored in two
 * `SharedArrayBuffer`s. This approach is necessary because Web Workers do not share
 * memory by default, requiring us to use SABs for high-performance data exchange.
 *
 * ### Correctness Note: 64-bit Pointers for Overflow Safety
 *
 * The `head` and `tail` pointers are unbounded and cumulative, meaning they are never reset
 * and increment for the lifetime of the application. Using a standard 32-bit integer
 * (`Int32Array`) for these pointers would introduce a critical overflow bug.
 *
 * **Calculation for 32-bit Overflow:**
 * - Max value of a signed 32-bit integer: 2,147,483,647
 * - At a high but plausible workload of 300,000 jobs/sec (5k jobs @ 60fps):
 * - Time to overflow: 2.147B / 300,000 ≈ 7,158 seconds ≈ **2 hours**
 *
 * An overflow would cause `head` and `tail` comparisons to fail, leading to memory
 * corruption as the deque wraps around and overwrites unread data.
 *
 * **The 64-bit Solution:**
 * This implementation uses `BigInt64Array` for its state pointers.
 * - Max value of a signed 64-bit integer: 9,223,372,036,854,775,807
 * - At the same workload of 300,000 jobs/sec:
 * - Time to overflow: 9.22 quintillion / 300,000 / (3600*24*365.25) ≈ **974,590 years**
 *
 * Using 64-bit integers makes the deque unconditionally safe from pointer overflow for
 * the practical lifetime of any application. This is a correctness fix, not over-engineering.
 *
 * ### Memory Layout
 * Each deque is backed by its own pair of dedicated `SharedArrayBuffer`s:
 *
 * 1.  `queueStatesSAB` (8 bytes): A small buffer holding the two 32-bit integer pointers
 *     that manage the state of the deque.
 *     -   `Int32Array[0]` (`head`): The index of the next job to be stolen (the "top" of the deque).
 *         It is read by all threads but only ever incremented by "thief" threads via `steal()`.
 *     -   `Int32Array[1]` (`tail`): The index for the next job to be pushed (the "bottom" of the deque).
 *         It is exclusively read and written by the "owner" thread via `push()` and `pop()`.
 *
 * 2.  `readyQueuesSAB` (`DEQUE_CAPACITY` * 4 bytes): A larger buffer that acts as a circular
 *     array holding the actual job IDs (`Uint32`).
 *
 * ### Comparison to Classic Chase-Lev Implementations
 * This implementation has several key differences from a textbook C/C++ version, primarily
 * due to the constraints and features of JavaScript:
 *
 * -   **Fixed Capacity:** Unlike C++ `std::deque` which can dynamically grow, our deque uses a
 *     fixed-size `SharedArrayBuffer` (`DEQUE_CAPACITY`). This is a fundamental limitation of
 *     SABs, which must be allocated with a fixed size. The capacity must be chosen carefully
 *     to be large enough for typical workloads without wasting excessive memory.
 *
 * -   **Unbounded Integer Indices & Index Masking:** The `head` and `tail` are 32-bit integers
 *     that are allowed to increment indefinitely. We use fast bitwise masking (`& (DEQUE_CAPACITY - 1)`)
 *     to map these unbounded indices to the physical, bounded `readyQueuesSAB`. This standard technique
 *     avoids the "ABA problem" that could occur if we were to wrap the indices themselves.
 *
 * -   **Explicit Atomics:** All cross-thread synchronization is performed explicitly using the
 *     `Atomics` API (`load`, `store`, `compareExchange`). This ensures memory visibility and
 *     ordering between the owner thread's `pop()` and a thief's `steal()`.
 *
 * ### Usage
 *  1. By the "owner" thread to `push` and `pop` jobs from its own local deque.
 *  2. By a "thief" thread to `steal` jobs from another thread's deque.
 *
 * ### Stealing Rules
 * - **Main Thread (ID 0):** Can steal `SCHEDULE` jobs from any worker thread's deque.
 * - **Worker Threads (ID > 0):** Can only steal `SCHEDULE` jobs from other worker threads.
 *   They are explicitly forbidden from stealing from the main thread's deque, as `UPDATE`
 *   and `PROCESS` jobs are not safe for parallel execution.
 */

export class WorkStealingDeque {
	constructor({ queueStatesSAB, readyQueuesSAB }) {
		this.queueStates = new BigInt64Array(queueStatesSAB)
		this.readyQueues = new Uint32Array(readyQueuesSAB)

		this.dequeCapacity = BigInt(DEQUE_CAPACITY)
		this.dequeMask = BigInt(DEQUE_MASK)

		// The offsets are now constants defined outside the class to prevent false sharing.
		this.headOffset = HEAD_OFFSET
		this.tailOffset = TAIL_OFFSET

		this.NO_JOB_AVAILABLE = -1
	}

	/**
	 * Resets the deque's state by setting head and tail pointers to 0.
	 * This should only be called by the owner thread when it's guaranteed
	 * that no other thread is attempting to access the deque (e.g., at the start of a frame).
	 */
	reset() {
		Atomics.store(this.queueStates, this.headOffset, 0n)
		Atomics.store(this.queueStates, this.tailOffset, 0n)
	}

	/**
	 * Pushes a job to the bottom. Only called by the OWNER.
	 */
	push(jobId) {
		const tail = Atomics.load(this.queueStates, this.tailOffset)
		const head = Atomics.load(this.queueStates, this.headOffset)

		if (tail - head >= this.dequeCapacity) {
			throw new Error(`Deque overflow: Capacity ${this.dequeCapacity} reached.`)
		}

		// Atomics.store to ensure the job data is visible
		// to thieves BEFORE they see the updated tail.
		Atomics.store(this.readyQueues, Number(tail & this.dequeMask), jobId)

		// Atomic store acts as a "Release" barrier.
		Atomics.store(this.queueStates, this.tailOffset, tail + 1n)
		return true
	}

	/**
	 * Pops a job from the bottom. Only called by the OWNER.
	 */
	pop() {
		let t = Atomics.load(this.queueStates, this.tailOffset) - 1n
		Atomics.store(this.queueStates, this.tailOffset, t)

		// Full Memory Barrier: Ensure thieves see the new tail before we read head
		Atomics.load(this.queueStates, this.headOffset)
		const h = Atomics.load(this.queueStates, this.headOffset)

		if (h > t) {
			// Queue was empty; undo the tail decrement
			Atomics.store(this.queueStates, this.tailOffset, h)
			return this.NO_JOB_AVAILABLE
		}

		// Capture the job ID BEFORE the final check
		const jobIndex = Number(t & this.dequeMask)
		const job = Atomics.load(this.readyQueues, jobIndex)

		if (h === t) {
			// Only one item was left. We must compete with potential thieves.
			if (Atomics.compareExchange(this.queueStates, this.headOffset, h, h + 1n) !== h) {
				// Thief won the race for the last item
				Atomics.store(this.queueStates, this.tailOffset, h + 1n)
				return this.NO_JOB_AVAILABLE
			}
			// Owner won; reset tail to match the new head
			Atomics.store(this.queueStates, this.tailOffset, h + 1n)
		}

		return job
	}

	/**
	 * Pushes a batch of jobs to the bottom. Only called by the OWNER.
	 * This is more efficient than calling push() in a loop as it only
	 * updates the tail pointer once for the entire batch.
	 * @param {number[]} jobIds - An array of job IDs to push.
	 */
	pushBatch(jobIds) {
		const tail = Atomics.load(this.queueStates, this.tailOffset)
		const head = Atomics.load(this.queueStates, this.headOffset)
		const count = BigInt(jobIds.length)

		if (tail - head + count > this.dequeCapacity) {
			throw new Error(`Deque overflow during pushBatch: Capacity ${this.dequeCapacity} would be exceeded.`)
		}

		// Non-atomic writes are safe here because the owner is the only thread
		// that writes to this part of the array. The final atomic store on the
		// tail acts as a release memory barrier.
		for (let i = 0; i < jobIds.length; i++) {
			const jobIndex = tail + BigInt(i)
			this.readyQueues[Number(jobIndex & this.dequeMask)] = jobIds[i]
		}

		Atomics.store(this.queueStates, this.tailOffset, tail + count)
	}
	/**
	 * Pushes a batch of jobs to the bottom of the deque.
	 *
	 * **WARNING:** This method is **NOT** thread-safe for general use. It is designed
	 * to be called **only** by a non-owner thread during a single-threaded
	 * setup phase (e.g., initial job distribution) when it is guaranteed that
	 * no other thread is accessing this deque.
	 *
	 * @param {number[]} jobIds - An array of job IDs to push.
	 */
	batchPush(jobIds) {
		const tail = Atomics.load(this.queueStates, this.tailOffset)
		const head = Atomics.load(this.queueStates, this.headOffset)
		const count = BigInt(jobIds.length)

		if (tail - head + count > this.dequeCapacity) {
			throw new Error(`Deque overflow during batchPush: Capacity ${this.dequeCapacity} would be exceeded.`)
		}

		for (let i = 0; i < jobIds.length; i++) {
			const jobIndex = tail + BigInt(i)
			this.readyQueues[Number(jobIndex & this.dequeMask)] = jobIds[i]
		}
		Atomics.store(this.queueStates, this.tailOffset, tail + count)
	}
	/**
	 * Steals from the top. Called by ANY thread.
	 */
	steal() {
		const head = Atomics.load(this.queueStates, this.headOffset)
		// Ensure we see the most recent tail from the owner.
		const tail = Atomics.load(this.queueStates, this.tailOffset)

		if (head >= tail) return this.NO_JOB_AVAILABLE

		// Atomically load the job ID. This is necessary because we are reading from
		// shared memory that the owner thread may have just written to. The preceding
		// atomic load on `tail` acts as an acquire fence, ensuring memory visibility.
		const jobId = Atomics.load(this.readyQueues, Number(head & this.dequeMask))

		const originalHead = Atomics.compareExchange(this.queueStates, this.headOffset, head, head + 1n)

		return originalHead === head ? jobId : this.NO_JOB_AVAILABLE
	}

	/**
	 * Steals half of the jobs from the top of this deque and pushes them
	 * into the thief's deque. Called by a THIEF thread.
	 * @param {WorkStealingDeque} thiefDeque - The deque of the thief thread to push stolen jobs into. * @param {number[]} out_stolenJobs - A pre-allocated array to write stolen jobs into, to avoid allocation.
	 * @returns {boolean} `true` if jobs were successfully stolen, `false` otherwise.
	 *
	 *  proportional \ adaptive work-stealing implementation - more efficient for large bursts.
	 * Not a steal-k (fixed size work-stealing).
	 *
	 */
	stealHalf(thiefDeque, out_stolenJobs) {
		const h = Atomics.load(this.queueStates, this.headOffset)
		const t = Atomics.load(this.queueStates, this.tailOffset)

		const size = t - h
		if (size <= 0n) {
			return false
		}

		// Determine how many jobs to attempt to steal.
		const numToSteal = size > 1n ? (size + 1n) / 2n : 1n
		out_stolenJobs.length = 0

		// Steal one-by-one. This is slower but guarantees correctness by avoiding
		// the race condition inherent in the previous batch-claim approach.
		for (let i = 0; i < numToSteal; i++) {
			const job = this.steal()
			if (job !== this.NO_JOB_AVAILABLE) {
				out_stolenJobs.push(job)
			} else {
				// Stop if the queue becomes empty.
				break
			}
		}

		if (out_stolenJobs.length > 0) {
			thiefDeque.pushBatch(out_stolenJobs)
			return true
		}
		return false
	}

	/**
	 * Returns the number of items currently in the deque.
	 * This should be considered an approximation in a multi-threaded context,
	 * as both the owner and thieves can be modifying the deque concurrently.
	 * @returns {number}
	 */
	size() {
		const head = Atomics.load(this.queueStates, this.headOffset)
		const tail = Atomics.load(this.queueStates, this.tailOffset)
		const size = tail - head
		// In the Chase-Lev pop(), head can temporarily exceed tail by 1.
		// We return 0 in this transient state for clearer debugging.
		return size > 0n ? Number(size) : 0
	}
}
