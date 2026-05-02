const { Kernel } = await import(`@managers/WorkerManager/Kernel.js`)
const { entityStore, MAX_COMPONENTS, MAX_CHUNK_CAPACITY } = await import(`@managers/EntityManager/EntityManager.js`)
import { DIRTY_HISTORY_LENGTH } from '../ComponentManager/ComponentSchema.js'
import { JobWriter } from './JobWriter.js'
const { kernelRegistry } = await import(`@managers/SystemManager/KernelRegistry.js`)
const { MPSCQueue, MPSC_QUEUE_CAPACITY } = await import(`@core/Algorithms/MPSCQueue.js`)
const { WorkStealingDeque, NO_JOB_AVAILABLE, DEQUE_CAPACITY } = await import(`@core/Algorithms/WorkStealingDeque.js`)

import {
	MAX_JOBS,
	MAX_DEPENDENTS,
	CACHE_LINE_SIZE,
	JOB_STRIDE_IN_BYTES,
	JOB_STRIDE_IN_U32,
	JOB_AFFINITY_OFFSET,
	JOB_PAYLOAD_OFFSET,
	JOB_DEP_LIST_START_OFFSET,
	JOB_DEP_LIST_COUNT_OFFSET,
	JOB_SYSTEM_ID_OFFSET,
	JOB_KERNEL_ID_OFFSET,
	JOB_DEP_COUNTER_OFFSET,
	JOB_TYPE,
	JOB_AFFINITY,
} from './JobLayout.js'

import {
	FRAME_STATE_TOTAL_JOBS_OFFSET,
	FRAME_STATE_COMPLETED_JOBS_OFFSET,
	FRAME_STATE_IDLE_THREADS_OFFSET,
	FRAME_STATE_BARRIER_COUNTER_OFFSET,
	FRAME_STATE_BARRIER_GENERATION_OFFSET,
	FRAME_STATE_SLEEP_GENERATION_OFFSET,
	FRAME_STATE_FRAME_GENERATION_OFFSET,
	FRAME_CONTEXT_FRAME_ID_OFFSET,
	FRAME_CONTEXT_CURRENT_TICK_OFFSET,
	FRAME_CONTEXT_LAST_TICK_OFFSET,
	FRAME_CONTEXT_DELTA_TIME_OFFSET,
	FRAME_CONTEXT_ALPHA_OFFSET,
} from './FrameStateLayout.js'

/**
 * Maps JOB_TYPE enum to method names for dependency lookups.
 */
const JOB_TYPE_TO_METHOD_NAME = ['update', null, 'process']

/**
 * --- ARCHITECTURAL NOTE on Private LIFO Buffers ---
 *
 * This scheduler intentionally does not implement a "private LIFO buffer" for each
 * thread, a pattern seen in some other job schedulers (e.g., Intel TBB)
 *
 *
 * Current archetechture sticks with "good enough" approach, prioritizing
 * simplicity (no juggling private => public storage, no publishing),
 * native self load-balancing (does not matter if initial load is balanced, all jobs are discoverable)
 * and cache locality - initial push does not have to be interleaved.
 *
 */
export class Scheduler {
	constructor() {
		// --- Shared State (Initialized in init) ---
		this.ecs = null
		this.workerManager = null
		this.systemManager = null

		this.sharedBuffers = {}
		this.frameContextI64View = null
		this.frameContextF64View = null
		this.mainThreadDeque = null
		this.mainThreadInbox = null
		this.inboxDrain = new Uint32Array(MPSC_QUEUE_CAPACITY) // Pre-allocated buffer for drained jobs.
		this.inboxDrainSize = 0 // Number of valid items in inboxDrain.
		this.jobWriter = new JobWriter()
		this.inboxDrainIndex = 0 // Current read position in inboxDrain.
		this.allDeques = [] // Will hold all deque instances
		this.mainThreadScratchBuffer = null
		this.mainThreadKernelContext = null

		// --- Reusable Arrays to Reduce GC Pressure ---
		// These are used in hot paths to avoid allocating new arrays on every job.
		this.reusableUnlockedMTOJobs = []
		this.reusableUnlockedAnyJobs = []
		this.reusableStealBuffer = []

		// --- Per-Execution State (Reset in execute) ---
		// Pre-allocate job objects to avoid GC pressure during graph build.
		this.jobs = new Array(MAX_JOBS)
		for (let i = 0; i < MAX_JOBS; i++) {
			// All properties that will be used in the build phase are pre-created.
			this.jobs[i] = {
				dependentsHead: -1, // Index of the first node in the dependency linked list
				dependentsTail: -1, // Index of the last node for O(1) appends
				dependentsCount: 0,
				system: null,
				reads: null,
				writes: null,
			}
		}
		// A pre-allocated pool for our dependency linked-list nodes.
		this.dependencyNodePool = new Array(MAX_DEPENDENTS)
		for (let i = 0; i < MAX_DEPENDENTS; i++) {
			this.dependencyNodePool[i] = { dependentId: 0, next: -1 }
		}
		this.dependencyNodeCounter = 0
		this.systemToJobIds = new Map() // Map<systemId, jobId[]>
		this.jobCounter = 0
		this.perFrameContext = null
		this.nextDistributeThread = 1 // For round-robin distribution, starts at worker 1.
		this.hasParallelJobs = false // Per-execution flag
	}

	async init(engine) {
		const { workerManager, systemManager, entityMaskManager } = engine.getManagers()
		this.workerManager = workerManager
		this.systemManager = systemManager
		this.entityMaskManager = entityMaskManager

		// --- Shared Memory Allocation ---
		// The Scheduler is the owner of all shared memory for the job system.
		this.sharedBuffers.frameStateSAB = new SharedArrayBuffer(8 * JOB_STRIDE_IN_BYTES) // Increased size for frame generation
		this.sharedBuffers.jobsSAB = new SharedArrayBuffer(MAX_JOBS * JOB_STRIDE_IN_BYTES)
		this.sharedBuffers.dependentsSAB = new SharedArrayBuffer(MAX_DEPENDENTS * 4)
		this.sharedBuffers.frameContextSAB = new SharedArrayBuffer(CACHE_LINE_SIZE) // 64 bytes for shared context

		// --- Main Thread Inbox (MPSC) Memory Allocation ---
		// Allocate enough space to put head, tail, and write_claim pointers on separate cache lines.
		const inboxStateSAB = new SharedArrayBuffer(3 * CACHE_LINE_SIZE)
		const inboxDataSAB = new SharedArrayBuffer(MPSC_QUEUE_CAPACITY * 4) // job IDs (Uint32)
		this.sharedBuffers.mainThreadInbox = { stateSAB: inboxStateSAB, dataSAB: inboxDataSAB }

		// --- Per-Thread Deque Memory Allocation ---
		this.sharedBuffers.dequeBuffers = []
		for (let i = 0; i < this.workerManager.totalThreads; i++) {
			// Allocate enough space to put head and tail on separate cache lines to prevent false sharing.
			const queueStatesSAB = new SharedArrayBuffer(2 * CACHE_LINE_SIZE) // 2 * 64 bytes
			const readyQueuesSAB = new SharedArrayBuffer(DEQUE_CAPACITY * 4) // job IDs (Uint32)
			this.sharedBuffers.dequeBuffers.push({ queueStatesSAB, readyQueuesSAB })

			this.allDeques[i] = new WorkStealingDeque({
				queueStatesSAB,
				readyQueuesSAB,
			})
		}

		// Register all shared buffers for worker initialization.
		this.workerManager.addInitialResource('frameStateSAB', this.sharedBuffers.frameStateSAB)
		this.workerManager.addInitialResource('jobsSAB', this.sharedBuffers.jobsSAB)
		this.workerManager.addInitialResource('dependentsSAB', this.sharedBuffers.dependentsSAB)
		this.workerManager.addInitialResource('frameContextSAB', this.sharedBuffers.frameContextSAB)
		this.workerManager.addInitialResource('mainThreadInbox', this.sharedBuffers.mainThreadInbox)
		this.workerManager.addInitialResource('dequeBuffers', this.sharedBuffers.dequeBuffers)

		// Create views for the new shared frame context buffer.
		this.frameContextI64View = new BigInt64Array(this.sharedBuffers.frameContextSAB)
		this.frameContextF64View = new Float64Array(this.sharedBuffers.frameContextSAB)

		// Create and initialize an instance of the parallel API for the main thread.
		// Make the parallel API globally available for kernels running on the main thread.
		self.kernel = new Kernel({ entityStore })
		// The main thread's deque is the first one in the array.
		this.mainThreadDeque = this.allDeques[0]

		// The main thread is the single consumer of its inbox.
		this.mainThreadInbox = new MPSCQueue(this.sharedBuffers.mainThreadInbox)

		// Initialize the scratch buffer for the main thread.
		this.mainThreadScratchBuffer = new Uint32Array(MAX_CHUNK_CAPACITY)

		this.mainThreadKernelContext = {
			getScratchBuffer: () => this.mainThreadScratchBuffer,
		}
	}

	/**
	 * Provides access to the shared buffers owned by the Scheduler.
	 * @returns {object} An object containing all the SharedArrayBuffers for the job system.
	 */
	getSharedBuffers() {
		return this.sharedBuffers
	}

	/**
	 * Executes a given set of systems for the current frame/tick.
	 * This is the main entry point for the scheduler. It builds the job graph,
	 * orchestrates worker execution, and returns a promise that resolves when
	 * all work for this set of systems is complete.
	 *
	 * @param {import('./System.js').System[]} systems - The array of systems to execute.
	 * @param {object} perFrameContext - The context object (deltaTime, etc.) for this execution.
	 * @param {number} frameId - A unique, incrementing ID for the current frame execution.
	 * @returns {Promise<void>} A promise that resolves when all jobs are complete.
	 */
	async execute(systems, perFrameContext, frameId) {
		if (systems.length === 0) {
			return
		}

		// 1. Reset per-execution state
		this._reset()

		// Store the context for this specific execution.
		this.perFrameContext = perFrameContext

		// 2. Build the Job Graph (as internal data structures)
		this._buildGraph(systems, perFrameContext)

		// Check if any parallel jobs were created.
		this.hasParallelJobs = this.jobs.some(job => job.type === JOB_TYPE.KERNEL)

		// 3. Write the graph data to the SharedArrayBuffers.
		this._writeGraphToSAB()

		// 4. Find and enqueue all jobs that are initially ready to run.
		this._enqueueInitialJobs()

		// 5. Signal workers to start processing, ONLY if there is parallel work.
		if (this.hasParallelJobs) {
			this._updateSharedFrameContext(this.perFrameContext, frameId)
			this._signalNewFrame()
		}

		// 6. Return a promise that resolves upon completion.
		// The main thread will now participate in the work-stealing loop
		// until all jobs are complete.
		return new Promise(resolve => {
			this._mainThreadWorkLoop(resolve, frameId)
		})
	}

	/**
	 * Resets the scheduler's state for a new execution.
	 * @private
	 */
	_reset() {
		this.jobCounter = 0
		this.dependencyNodeCounter = 0
		this.systemToJobIds.clear()
		this.perFrameContext = null
		this.inboxDrainSize = 0
		this.inboxDrainIndex = 0
		for (let i = 0; i < MAX_JOBS; i++) {
			this.jobs[i].dependentsHead = -1
			this.jobs[i].dependentsTail = -1
			this.jobs[i].dependentsCount = 0
			this.jobs[i].system = null
			this.jobs[i].reads = null
			this.jobs[i].writes = null
		}
		this.hasParallelJobs = false

		this.nextDistributeThread = 1 // Reset round-robin counter.
		// Reset per-frame atomic counters.
		const frameState = new BigInt64Array(this.sharedBuffers.frameStateSAB)
		Atomics.store(frameState, FRAME_STATE_COMPLETED_JOBS_OFFSET, 0n)
		Atomics.store(frameState, FRAME_STATE_IDLE_THREADS_OFFSET, 0n)
		Atomics.store(frameState, FRAME_STATE_BARRIER_COUNTER_OFFSET, 0n)
		// The sleep and frame generation counters are persistent and should not be reset per frame.

		// Reset all work-stealing deques by setting their head and tail pointers to 0.
		for (const deque of this.allDeques) {
			deque.reset()
		}

		// Reset the main thread inbox.
		this.mainThreadInbox.reset()
	}

	/**
	 * Writes the per-frame context data to the shared buffer for workers to read.
	 * @param {object} context The per-frame context from the game loop.
	 * @param {number} frameId The current frame/execution ID.
	 * @private
	 */
	_updateSharedFrameContext(context, frameId) {
		this.frameContextI64View[FRAME_CONTEXT_FRAME_ID_OFFSET] = BigInt(frameId)
		this.frameContextI64View[FRAME_CONTEXT_CURRENT_TICK_OFFSET] = BigInt(context.currentTick)
		this.frameContextI64View[FRAME_CONTEXT_LAST_TICK_OFFSET] = BigInt(context.lastTick)
		// These are indexed by Float64 size (8 bytes), so index 3 is at byte offset 24.
		this.frameContextF64View[FRAME_CONTEXT_DELTA_TIME_OFFSET] = context.deltaTime
		this.frameContextF64View[FRAME_CONTEXT_ALPHA_OFFSET] = context.alpha
	}

	_signalNewFrame() {
		const frameState = new BigInt64Array(this.sharedBuffers.frameStateSAB)
		Atomics.add(frameState, FRAME_STATE_FRAME_GENERATION_OFFSET, 1n)
		Atomics.notify(frameState, FRAME_STATE_FRAME_GENERATION_OFFSET, Infinity)
	}

	/**
	 * Builds the dependency graph for the given systems.
	 * This implements the two-pass process from the architectural plan.
	 * @param {import('./System.js').System[]} systems - The systems to include in the graph.
	 * @param {object} perFrameContext - The context for this execution.
	 * @private
	 */
	_buildGraph(systems, perFrameContext) {
		// --- Pass 1: Create all jobs and map systems to their job IDs ---
		if (this.jobs.length > MAX_JOBS) {
			throw new Error(`[Scheduler] Exceeded MAX_JOBS (${this.jobs.length}/${MAX_JOBS}). Increase MAX_JOBS constant.`)
		}

		const jobsView = new Int32Array(this.sharedBuffers.jobsSAB)

		// This pass populates `this.jobs` and `this.systemToJobIds`.
		for (const system of systems) {
			const jobIdsForSystem = []
			const systemName = system.constructor.name

			// Get the pre-analyzed, cached metadata for this system.
			const systemId = this.systemManager.getSystemId(systemName)
			const metadata = this.systemManager.systemMetadataCache.get(systemId)
			if (!metadata) {
				console.warn(`[Scheduler] Could not find cached metadata for system "${systemName}". Skipping.`)
				continue
			}

			// Prime the system's reactive queries with the correct lastTick from the context.
			if (system.reactive) {
				for (const query of system.reactiveQueries) {
					query.iterationLastTick = perFrameContext.lastTick
					query.iterationCurrentTick = perFrameContext.currentTick
				}
			}

			// A. Create UPDATE job (if update() exists)
			if (metadata.hasUpdate) {
				const jobId = this.jobCounter++
				const job = this.jobs[jobId]

				job.id = jobId
				job.systemId = systemId
				job.system = system
				job.type = JOB_TYPE.UPDATE
				job.dependencyCounter = 0
				job.affinity = JOB_AFFINITY.MAIN_THREAD
				jobIdsForSystem.push(jobId)
				job.kernelId = 0 // Reset/default

				const deps = metadata.dependencies.get(JOB_TYPE.UPDATE) || {}
				job.reads = deps.reads || new Set()
				job.writes = deps.writes || new Set()
			}

			// B. Create KERNEL jobs (if schedule() exists)
			if (metadata.hasSchedule) {
				const scheduleStartTime = performance.now()

				const startJobIndex = this.jobCounter

				// Reuse the single JobWriter instance.
				this.jobWriter.reset({
					jobsView: jobsView,
					jobCounter: this.jobCounter,
					systemId: systemId,
				})
				system.schedule(this.jobWriter, perFrameContext)

				// The writer has written the raw job data to the SAB. Now, the Scheduler
				// builds the in-memory representation needed for dependency resolution.
				const endJobIndex = this.jobWriter.jobCounter
				for (let jobId = startJobIndex; jobId < endJobIndex; jobId++) {
					const jobOffset = jobId * JOB_STRIDE_IN_U32
					const kernelId = jobsView[jobOffset + JOB_KERNEL_ID_OFFSET]
					const payload = jobsView[jobOffset + JOB_PAYLOAD_OFFSET] & 0x00ffffff

					const kernelMeta = kernelRegistry.kernelMetadata.get(kernelId)
					if (!kernelMeta) {
						console.warn(`[Scheduler] Could not find metadata for kernel with ID ${kernelId}.`)
						continue
					}

					const job = this.jobs[jobId]
					job.id = jobId
					job.systemId = systemId
					job.system = system
					job.type = JOB_TYPE.KERNEL
					job.kernelId = kernelId
					job.payload = payload
					job.dependencyCounter = 0
					job.affinity = JOB_AFFINITY.ANY_WORKER

					const deps = metadata.dependencies.get(kernelId) || {}
					job.reads = deps.reads || new Set()
					job.writes = deps.writes || new Set()

					jobIdsForSystem.push(jobId)
				}
				this.jobCounter = endJobIndex // Update the main counter.

				const scheduleEndTime = performance.now()
				// Record the time it took to create the job definitions.
				this.systemManager.recordSystemTiming(systemId, JOB_TYPE.KERNEL, scheduleEndTime - scheduleStartTime)

				if (this.jobCounter >= MAX_JOBS) {
					throw new Error(`[Scheduler] Exceeded MAX_JOBS. Increase MAX_JOBS constant.`)
				}
			}

			// C. Create PROCESS job (if process() exists)
			if (metadata.hasProcess) {
				const jobId = this.jobCounter++
				const job = this.jobs[jobId]
				job.id = jobId
				job.systemId = systemId
				job.system = system
				job.type = JOB_TYPE.PROCESS
				job.dependencyCounter = 0
				job.affinity = JOB_AFFINITY.MAIN_THREAD
				jobIdsForSystem.push(jobId)
				job.kernelId = 0 // Reset/default

				const deps = metadata.dependencies.get(JOB_TYPE.PROCESS) || {}
				job.reads = deps.reads || new Set()
				job.writes = deps.writes || new Set()
			}

			if (jobIdsForSystem.length > 0) {
				this.systemToJobIds.set(systemId, jobIdsForSystem)
			}
		}

		// --- Pass 2: Resolve all dependencies ---
		// This pass iterates through all created jobs and wires up their
		// dependency counters and dependent lists based on the rules in the plan.

		// The order of resolution here is important to follow the priority rules.
		// We will add dependencies in stages.

		// 1. Resolve `runsAfter` (Control-flow) dependencies. (Highest Priority)
		this._resolveControlFlowDependencies(systems)

		// 2. Resolve local phase (`update`->`schedule`->`process`) dependencies.
		this._resolveLocalPhaseDependencies()

		// 3. Resolve `reads`/`writes` (Data-flow) dependencies. (Default)
		this._resolveDataFlowDependencies()

		// 4. Detect and throw on circular dependencies. (Final validation)
		this._detectAndThrowOnCycles()
	}

	/**
	 * Serializes the in-memory job graph into the shared buffers (`jobsSAB`, `dependentsSAB`)
	 * and updates the global frame state.
	 * @private
	 */
	_writeGraphToSAB() {
		const jobsView = new Int32Array(this.sharedBuffers.jobsSAB)
		const dependentsView = new Uint32Array(this.sharedBuffers.dependentsSAB) // This is fine, not used with wait/notify
		const frameState = new BigInt64Array(this.sharedBuffers.frameStateSAB)

		let dependentsWriteIndex = 0

		for (let i = 0; i < this.jobCounter; i++) {
			const job = this.jobs[i]
			const jobOffset = job.id * JOB_STRIDE_IN_U32

			// For non-KERNEL jobs (UPDATE/PROCESS), their data has not been written to the SAB yet.
			// The JobWriter only handles KERNEL jobs. So we write them here.
			if (job.type !== JOB_TYPE.KERNEL) {
				const jobPayload = (job.type << 24) | (job.payload || 0)
				jobsView[jobOffset + JOB_AFFINITY_OFFSET] = job.affinity
				jobsView[jobOffset + JOB_PAYLOAD_OFFSET] = jobPayload
				jobsView[jobOffset + JOB_SYSTEM_ID_OFFSET] = job.systemId
				jobsView[jobOffset + JOB_KERNEL_ID_OFFSET] = 0 // Sentinel for non-kernel jobs
			}

			// Now, write the data that is calculated *after* initial job creation:
			// the dependency list and the final dependency counter. This applies to ALL job types.

			// Write the job's dependents to the flat dependents list by traversing our linked list.
			const depListStart = dependentsWriteIndex
			let currentNodeIndex = job.dependentsHead
			while (currentNodeIndex !== -1) {
				const node = this.dependencyNodePool[currentNodeIndex]
				if (dependentsWriteIndex >= MAX_DEPENDENTS) {
					throw new Error(
						`[Scheduler] Exceeded MAX_DEPENDENTS (${dependentsWriteIndex}/${MAX_DEPENDENTS}). Increase MAX_DEPENDENTS constant.`,
					)
				}
				dependentsView[dependentsWriteIndex++] = node.dependentId
				currentNodeIndex = node.next
			}

			// Write the dependency list pointers to the job struct.
			jobsView[jobOffset + JOB_DEP_LIST_START_OFFSET] = depListStart
			jobsView[jobOffset + JOB_DEP_LIST_COUNT_OFFSET] = job.dependentsCount

			// The dependency counter is the most frequently updated part during execution,
			// but it's calculated during graph build, so we write its final initial value here.
			jobsView[jobOffset + JOB_DEP_COUNTER_OFFSET] = job.dependencyCounter
		}

		// --- Final Step: Signal to workers that the graph is ready ---
		// Atomically store the total number of jobs. Workers poll this value.
		// A change from 0 to a non-zero value indicates a new frame has begun.
		Atomics.store(frameState, FRAME_STATE_TOTAL_JOBS_OFFSET, BigInt(this.jobCounter))
	}

	/**
	 * Finds all jobs with no dependencies and enqueues them into the appropriate
	 * thread's deque to kick off execution.
	 * @private
	 */
	_enqueueInitialJobs() {
		const jobsView = new Int32Array(this.sharedBuffers.jobsSAB)
		const readyAnyWorkerJobs = []

		// 1. Collect all ready jobs, routing Main-Thread-Only (MTO) jobs immediately.
		for (let jobId = 0; jobId < this.jobCounter; jobId++) {
			const jobOffset = jobId * JOB_STRIDE_IN_U32
			const dependencyCounter = jobsView[jobOffset + JOB_DEP_COUNTER_OFFSET]

			if (dependencyCounter === 0) {
				const affinity = jobsView[jobOffset + JOB_AFFINITY_OFFSET]
				if (affinity === JOB_AFFINITY.MAIN_THREAD) {
					this.mainThreadInbox.push(jobId)
				} else {
					readyAnyWorkerJobs.push(jobId)
				}
			}
		}

		// 2. Distribute parallel jobs in large, contiguous batches to preserve data locality.
		const workerCount = this.workerManager.totalThreads - 1
		if (workerCount > 0 && readyAnyWorkerJobs.length > 0) {
			const numJobs = readyAnyWorkerJobs.length
			const baseJobsPerWorker = Math.floor(numJobs / workerCount)
			const remainder = numJobs % workerCount
			let jobIndex = 0

			for (let i = 0; i < workerCount; i++) {
				const workerId = i + 1
				const jobsForThisWorker = baseJobsPerWorker + (i < remainder ? 1 : 0)

				if (jobsForThisWorker === 0) continue

				const start = jobIndex
				const end = start + jobsForThisWorker

				const jobSlice = readyAnyWorkerJobs.slice(start, end) //!
				// This is a special, non-thread-safe push for the initial setup phase.
				this.allDeques[workerId].batchPush(jobSlice)
				jobIndex = end
			}
		}
	}

	/**
	 * The main thread's work-stealing loop. It processes its own jobs and
	 * steals from workers when idle.
	 * @param {Function} resolve - The promise resolver to call when all work is done.
	 * @param {number} frameId - The current frame ID for context.
	 * @private
	 */
	_mainThreadWorkLoop(resolve, frameId) {
		const frameState = new BigInt64Array(this.sharedBuffers.frameStateSAB)
		const totalJobs = Atomics.load(frameState, FRAME_STATE_TOTAL_JOBS_OFFSET)

		// This is the main execution loop for the main thread.
		const workLoop = async () => {
			let completedJobs = Atomics.load(frameState, FRAME_STATE_COMPLETED_JOBS_OFFSET)

			while (completedJobs < totalJobs) {
				const jobId = this._findJobForMainThread()

				if (jobId !== -1) {
				this._executeJob(jobId, 0, frameId)
				} else {
					// No job found. Go to sleep until woken up by another thread.
					await this._goToSleep(frameId)
				}
				completedJobs = Atomics.load(frameState, FRAME_STATE_COMPLETED_JOBS_OFFSET)
			}

			// If there were no parallel jobs, no workers were activated, so we can skip the barrier.
			if (this.hasParallelJobs) {
				// --- End-of-Frame Barrier ---
				// All jobs for this group are complete. The main thread must now participate
				// in a barrier to ensure all workers have also finished their loops before proceeding.
				const totalThreads = this.workerManager.totalThreads
				const counterOffset = FRAME_STATE_BARRIER_COUNTER_OFFSET
				const generationOffset = FRAME_STATE_BARRIER_GENERATION_OFFSET

				// 1. Capture the current barrier generation.
				const myGeneration = Atomics.load(frameState, generationOffset)

				// 2. Atomically increment the counter of threads at the barrier.
				const count = Atomics.add(frameState, counterOffset, 1n) + 1n

				if (count === BigInt(totalThreads)) {
					// 3a. I am the LAST thread. Reset the counter for the next frame.
					Atomics.store(frameState, counterOffset, 0n)
					// 3b. Increment the generation to release the waiting threads.
					Atomics.add(frameState, generationOffset, 1n)
					// 3c. Notify all waiting threads that the generation has changed.
					Atomics.notify(frameState, generationOffset, totalThreads - 1)
				} else {
					// 4. I am NOT the last thread. Wait for the generation to change.
					// The wait is in a loop to handle spurious wakeups.
					while (Atomics.load(frameState, generationOffset) === myGeneration) {
						await Atomics.waitAsync(frameState, generationOffset, myGeneration).value
					}
				}
			}

			resolve()
		}

		// Start the loop.
		workLoop()
	}

	/**
	 * Finds a job for the given thread to execute.
	 * It first tries to pop from the thread's own deque, then attempts to steal.
	 * @param {number} threadId - The ID of the thread looking for work.
	 * @param {boolean} [enableLogging=false] - If true, logs the process for this thread.
	 * @returns {number} The ID of the found job, or -1 if no job is available.
	 * @private
	 */
	_findJobForMainThread() {
		// Priority 1: Drain and process the MPSC Inbox from workers.
		// We process jobs from a pre-allocated typed array to avoid GC pressure.
		if (this.inboxDrainIndex >= this.inboxDrainSize) {
			// If we've processed all drained jobs, drain the queue again.
			this.inboxDrainSize = this.mainThreadInbox.drain(this.inboxDrain)
			this.inboxDrainIndex = 0
		}

		if (this.inboxDrainIndex < this.inboxDrainSize) {
			// Process the next job from our typed array buffer.
			const jobFromInbox = this.inboxDrain[this.inboxDrainIndex++]
			return jobFromInbox
		}

		// Priority 2: Pop from local deque (LIFO). This is the fastest path for self-generated work.
		const localJob = this.mainThreadDeque.pop()
		if (localJob !== NO_JOB_AVAILABLE) {
			return localJob
		}

		// Priority 3: Steal from workers if we are idle.
		// Only attempt to steal if there are parallel jobs in the system.
		const totalThreads = this.workerManager.totalThreads
		if (!this.hasParallelJobs || totalThreads <= 1) return NO_JOB_AVAILABLE

		// --- Ring Neighbor-First Stealing Strategy ---
		// The main thread (ID 0) will attempt to steal from workers in a fixed ring order: 1, 2, 3, ... N-1.
		const workerCount = totalThreads - 1

		for (let i = 0; i < workerCount; i++) {
			// The victim ID cycles from 1 to workerCount.
			const victimId = (i % workerCount) + 1

			// Use the pre-cached deque instance for the victim worker thread.
			const victimDeque = this.allDeques[victimId]
			this.reusableStealBuffer.length = 0
			if (victimDeque.stealHalf(this.mainThreadDeque, this.reusableStealBuffer)) {
				// Steal was successful. Jobs are now in our local deque.
				// Pop one to execute immediately. This is guaranteed to succeed
				// unless another thread stole from us in the tiny window since
				// the steal completed, which is extremely unlikely but possible.
				const job = this.mainThreadDeque.pop()
				if (job !== NO_JOB_AVAILABLE) {
					return job
				}
				// If pop failed, just continue the loop to try another victim.
			}
		}

		return NO_JOB_AVAILABLE // No work found to steal.
	}

	/**
	 * Puts the main thread to sleep when it is idle, waiting for new work.
	 * @private
	 */
	async _goToSleep(frameId) {
		const frameState = new BigInt64Array(this.sharedBuffers.frameStateSAB)
		const idleOffset = FRAME_STATE_IDLE_THREADS_OFFSET
		const generationOffset = FRAME_STATE_SLEEP_GENERATION_OFFSET

		// Capture the sleep generation *before* the final check for work.
		// This is critical to closing a race condition where a wakeup signal could be
		// missed between the final check and the call to Atomics.wait.
		const myGeneration = Atomics.load(frameState, generationOffset)

		// Increment the idle counter to signal our intent to sleep.
		Atomics.add(frameState, idleOffset, 1n)

		// --- Last check for work OR completion before sleeping ---
		// This is crucial to prevent a "lost wakeup" race condition.

		// Check 1: Is the frame already done?
		const totalJobs = Atomics.load(frameState, FRAME_STATE_TOTAL_JOBS_OFFSET)
		const completedJobs = Atomics.load(frameState, FRAME_STATE_COMPLETED_JOBS_OFFSET)
		if (completedJobs >= totalJobs) {
			// The frame finished while we were preparing to sleep. Abort sleep and go to the barrier.
			Atomics.sub(frameState, idleOffset, 1n) // We are not idle anymore.
			return // This will cause the main work loop to terminate and proceed to the barrier.
		}

		// Check 2: Did a new job appear?
		const finalCheckJobId = this._findJobForMainThread()
		if (finalCheckJobId !== NO_JOB_AVAILABLE) {
			// A job appeared! Decrement the idle counter and execute the job instead of sleeping.
			// We are no longer idle, so decrement the counter and execute the job.
			// This is a normal race-avoidance path, so no log is needed.
			Atomics.sub(frameState, idleOffset, 1n)
			this._executeJob(finalCheckJobId, 0, frameId)
			return
		}

		// Go to sleep, waiting for the generation to change.
		// The loop handles spurious wakeups.
		while (Atomics.load(frameState, generationOffset) === myGeneration) {
			await Atomics.waitAsync(frameState, generationOffset, myGeneration).value
		}
		// We have woken up and are no longer idle. Decrement the counter.
		Atomics.sub(frameState, idleOffset, 1n)
	}

	/**
	 * Wakes up a specified number of sleeping threads (main or worker).
	 * This is called when new work becomes available that an idle thread could potentially pick up.
	 * @private
	 */
	_wakeIdleThreads(count = Infinity) {
		const frameState = new BigInt64Array(this.sharedBuffers.frameStateSAB)
		const idleOffset = FRAME_STATE_IDLE_THREADS_OFFSET
		const generationOffset = FRAME_STATE_SLEEP_GENERATION_OFFSET

		// Only notify if there are actually threads waiting. This is a crucial optimization
		// to avoid the overhead of a `notify` call when all threads are busy.
		const idleCount = Atomics.load(frameState, idleOffset)
		if (idleCount > 0n) {
			// Increment the generation to signal a wakeup event.
			Atomics.add(frameState, generationOffset, 1n)
			// Notify ALL threads waiting on the generation counter to avoid lost wakeups.
			Atomics.notify(frameState, generationOffset, count)
		}
	}

	/**
	 * Executes a single job.
	 * @param {number} jobId - The ID of the job to execute.
	 * @param {number} threadId - The ID of the thread executing the job.
	 * @private
	 */
	_executeJob(jobId, threadId, frameId) {
		const jobsView = new Int32Array(this.sharedBuffers.jobsSAB)
		const jobOffset = jobId * JOB_STRIDE_IN_U32

		const systemId = jobsView[jobOffset + JOB_SYSTEM_ID_OFFSET]
		const jobPayload = jobsView[jobOffset + JOB_PAYLOAD_OFFSET]

		const startTime = performance.now()
		const jobType = jobPayload >> 24;

		try {
			const job = this.jobs[jobId]
			const system = job.system

			if (!system) {
				const systemName = this.systemManager.getSystemNameById(systemId)
				console.error(
					`[Scheduler] Could not find system instance for "${systemName}" (ID: ${systemId}) during job execution.`,
				)
			} else {
				const payload = jobPayload & 0x00ffffff;
				switch (jobType) {
					case JOB_TYPE.UPDATE:
						system.update(this.perFrameContext)
						break
					case JOB_TYPE.KERNEL: {
						const oldFrameContext = self.frameContext
						self.frameContext = this.perFrameContext // Make it global for the kernel

						const kernelId = jobsView[jobOffset + JOB_KERNEL_ID_OFFSET]
						const kernelFn = kernelRegistry.idToKernel.get(kernelId)
						if (!kernelFn) {
							console.error(`[Scheduler] Main thread could not find kernel function for ID ${kernelId}`)
							break
						}

						// Fast path: Look up pre-compiled context from the SystemManager's cache.
						const systemContext = this.systemManager.allSystemContexts[systemId]?.[kernelId] || {} // Reset pool for each job.
						self.kernel.resetJobState()
						kernelFn(payload, systemContext, this.mainThreadKernelContext)
						self.frameContext = oldFrameContext // Restore global context
						break
					}
					case JOB_TYPE.PROCESS:
						system.process(this.perFrameContext)
						break
				}
			}
		} catch (error) {
			const systemName = this.systemManager.getSystemNameById(systemId)
			console.error(`[Scheduler] Error executing job for system "${systemName}" (ID: ${systemId}):`, error)
		}

		const endTime = performance.now()
		const duration = endTime - startTime
		if (jobType === JOB_TYPE.KERNEL) {
			this.systemManager.recordSystemTiming(systemId, 'total_only', duration)
		} else {
			this.systemManager.recordSystemTiming(systemId, jobType, duration)
		}

		// After "execution", process the job's dependents.
		this._processDependents(jobId, threadId, frameId)

		// Finally, increment the global completed jobs counter.
		const frameState = new BigInt64Array(this.sharedBuffers.frameStateSAB)
		const newCompletedJobs = Atomics.add(frameState, FRAME_STATE_COMPLETED_JOBS_OFFSET, 1n) + 1n
		const totalJobs = Atomics.load(frameState, FRAME_STATE_TOTAL_JOBS_OFFSET)

		if (newCompletedJobs >= totalJobs) {
			// This thread just completed the last job. It is responsible for waking up any
			// other threads that may have gone to sleep before realizing the frame was finished.
			// This prevents the "completion race" deadlock.
			this._wakeIdleThreads()
		}
	}

	/**
	 * After a job completes, this function decrements the dependency counters
	 * of all its dependent jobs. If a dependent's counter reaches zero, it is
	 * enqueued to be executed.
	 * @param {number} completedJobId - The ID of the job that just finished.
	 * @param {number} currentThreadId - The ID of the thread that finished the job.
	 * @private
	 */
	_processDependents(completedJobId, currentThreadId, frameId) {
		const jobsView = new Int32Array(this.sharedBuffers.jobsSAB)
		const dependentsView = new Uint32Array(this.sharedBuffers.dependentsSAB) // This is fine

		const jobOffset = completedJobId * JOB_STRIDE_IN_U32
		const depListStart = jobsView[jobOffset + JOB_DEP_LIST_START_OFFSET]
		const depListCount = jobsView[jobOffset + JOB_DEP_LIST_COUNT_OFFSET]

		// Reuse pre-allocated arrays to avoid GC pressure in this hot path.
		// This mirrors the optimization made in the worker's processDependents.
		this.reusableUnlockedMTOJobs.length = 0
		this.reusableUnlockedAnyJobs.length = 0
		const unlockedMTOJobs = this.reusableUnlockedMTOJobs
		const unlockedAnyJobs = this.reusableUnlockedAnyJobs

		for (let i = 0; i < depListCount; i++) {
			const dependentJobId = dependentsView[depListStart + i]
			const dependentJobOffset = dependentJobId * JOB_STRIDE_IN_U32

			// Atomically decrement the counter and check if it reached zero.
			if (Atomics.sub(jobsView, dependentJobOffset + JOB_DEP_COUNTER_OFFSET, 1) === 1) {
				// The counter was 1 before we subtracted, so it's now 0.
				// This job is now ready to run.
				const affinity = jobsView[dependentJobOffset + JOB_AFFINITY_OFFSET]

				if (affinity === JOB_AFFINITY.MAIN_THREAD) {
					// This is an MTO job. Push it to the private inbox.
					unlockedMTOJobs.push(dependentJobId)
				} else {
					// This is an ANY_WORKER job. The main thread must distribute it.
					unlockedAnyJobs.push(dependentJobId)
				}
			}
		}

		// Batch-enqueue the unlocked jobs.
		for (const jobId of unlockedMTOJobs) {
			this.mainThreadInbox.push(jobId)
		}

		if (unlockedAnyJobs.length > 0) {
			this.mainThreadDeque.pushBatch(unlockedAnyJobs)
			this._wakeIdleThreads(unlockedAnyJobs.length)
		}
	}

	/**
	 * Helper to create a dependency between two jobs using the allocation-free linked list.
	 * @param {object} prereqJob - The job that must run first.
	 * @param {object} dependentJob - The job that depends on the first one.
	 * @private
	 */
	_addDependency(prereqJob, dependentJob) {
		if (prereqJob.id === dependentJob.id) return

		// Get a node from the pre-allocated pool.
		const newNodeIndex = this.dependencyNodeCounter++
		if (newNodeIndex >= MAX_DEPENDENTS) {
			throw new Error(`[Scheduler] Exceeded MAX_DEPENDENTS during graph build.`)
		}
		const newNode = this.dependencyNodePool[newNodeIndex]
		newNode.dependentId = dependentJob.id
		newNode.next = -1

		// Append it to the prerequisite job's linked list of dependents.
		if (prereqJob.dependentsHead === -1) {
			prereqJob.dependentsHead = newNodeIndex
		} else {
			this.dependencyNodePool[prereqJob.dependentsTail].next = newNodeIndex
		}
		prereqJob.dependentsTail = newNodeIndex
		prereqJob.dependentsCount++
		dependentJob.dependencyCounter++
	}
	/**
	 * Wires up explicit `runsAfter` control-flow dependencies between systems.
	 * This creates a "fan-out/fan-in" barrier between two systems.
	 * Makes every job of the current system dependent on every job of the prerequisite system
	 * @param {import('./System.js').System[]} systems - The systems being executed.
	 * @private
	 */
	_resolveControlFlowDependencies(systems) {
		for (const dependentSystem of systems) {
			const dependentSystemName = dependentSystem.constructor.name
			const dependentSystemId = this.systemManager.getSystemId(dependentSystemName)
			const metadata = this.systemManager.systemMetadataCache.get(dependentSystemId)

			if (!metadata || metadata.runsAfter.length === 0) {
				continue
			}

			const dependentJobIds = this.systemToJobIds.get(dependentSystemId)
			if (!dependentJobIds || dependentJobIds.length === 0) {
				continue // This system produced no jobs to be dependent.
			}

			for (const prereqSystemId of metadata.runsAfter) {
				const prereqJobIds = this.systemToJobIds.get(prereqSystemId)

				if (!prereqJobIds || prereqJobIds.length === 0) {
					// This is not necessarily an error; the prerequisite system might not
					// be part of the current execution group or might not have produced any jobs.
					continue
				}

				// Make every job in the dependent system depend on every job in the prerequisite system.
				for (const prereqJobId of prereqJobIds) {
					for (const dependentJobId of dependentJobIds) {
						// This check is a micro-optimization. If the dependency already exists
						// (e.g., from data-flow analysis), don't add it again.
						// For control flow, we can skip this check as it's the first pass.
						// But for data flow, it's important.
						this._addDependency(this.jobs[prereqJobId], this.jobs[dependentJobId])
					}
				}
			}
		}
	}

	/**
	 * Wires up the dependencies for systems that use the local phased contract
	 * (`update` -> `schedule` -> `process`).
	 * @private
	 */
	_resolveLocalPhaseDependencies() {
		for (const jobIds of this.systemToJobIds.values()) {
			// A system might not be "phased", so we check.
			if (jobIds.length < 2) {
				continue
			}

			const updateJobs = []
			const kernelJobs = []
			const processJobs = []

			// Categorize jobs by type for this system
			for (const jobId of jobIds) {
				const job = this.jobs[jobId]
				if (job.type === JOB_TYPE.UPDATE) {
					updateJobs.push(job)
				} else if (job.type === JOB_TYPE.KERNEL) {
					kernelJobs.push(job)
				} else if (job.type === JOB_TYPE.PROCESS) {
					processJobs.push(job)
				}
			}

			// A system can only have one UPDATE and one PROCESS job.
			const updateJob = updateJobs[0]
			const processJob = processJobs[0]

			// Create `update` -> `kernel` dependencies. All kernels must wait for the update phase.
			if (updateJob && kernelJobs.length > 0) {
				for (const kernelJob of kernelJobs) {
					this._addDependency(updateJob, kernelJob)
				}
			}

			// The `process` job is a finalizer and must run after all other jobs for the system.
			if (processJob && updateJob) {
				this._addDependency(updateJob, processJob)
			}
			// Create `kernel` -> `process` dependencies
			if (processJob && kernelJobs.length > 0) {
				for (const kernelJob of kernelJobs) {
					this._addDependency(kernelJob, processJob)
				}
			}
		}
	}

	/**
	 * Wires up data-flow dependencies based on component `reads` and `writes`.
	 * This uses a linear scan over the jobs, tracking the last jobs to read or write
	 * each component type. It implements the special rule to avoid serializing
	 * parallel jobs from the same system.
	 * @private
	 */
	_resolveDataFlowDependencies() {
		const lastWriter = new Int32Array(MAX_COMPONENTS).fill(-1)
		const lastReaders = Array.from({ length: MAX_COMPONENTS }, () => [])

		for (let i = 0; i < this.jobCounter; i++) {
			const job = this.jobs[i]
			const { reads, writes } = job

			// --- 1. Resolve Write Dependencies (WAW & RAW) ---
			// A job that writes to a component must run after any previous job that
			// reads from or writes to that same component.
			for (const typeId of writes) {
				// Check for Write-After-Write (WAW) conflict.
				if (lastWriter[typeId] !== -1) {
					const prereqJob = this.jobs[lastWriter[typeId]]
					// The special rule: do not create dependencies between parallel jobs of the same system.
					if (
						!(job.type === JOB_TYPE.KERNEL && prereqJob.type === JOB_TYPE.KERNEL && job.systemId === prereqJob.systemId)
					) {
						this._addDependency(prereqJob, job)
					}
				}

				// Check for Read-After-Write (RAW) conflicts.
				if (lastReaders[typeId].length > 0) {
					for (const readerJobId of lastReaders[typeId]) {
						const prereqJob = this.jobs[readerJobId]
						if (
							!(
								job.type === JOB_TYPE.KERNEL &&
								prereqJob.type === JOB_TYPE.KERNEL &&
								job.systemId === prereqJob.systemId
							)
						) {
							this._addDependency(prereqJob, job)
						}
					}
				}

				// This writer is now the latest access, invalidating previous readers for this component.
				lastReaders[typeId].length = 0
				lastWriter[typeId] = job.id
			}

			// --- 2. Resolve Read Dependencies (WAR) ---
			// A job that reads from a component must run after any previous job
			// that writes to that same component.
			for (const typeId of reads) {
				// Check for Write-After-Read (WAR) conflict.
				if (lastWriter[typeId] !== -1) {
					const prereqJob = this.jobs[lastWriter[typeId]]
					if (
						!(job.type === JOB_TYPE.KERNEL && prereqJob.type === JOB_TYPE.KERNEL && job.systemId === prereqJob.systemId)
					) {
						this._addDependency(prereqJob, job)
					}
				}
				// Add this job to the list of readers for this component.
				lastReaders[typeId].push(job.id)
			}
		}
	}

	/**
	 * Detects circular dependencies in the job graph and throws an error if found.
	 * This uses Kahn's algorithm (topological sort approach).
	 * @private
	 */
	_detectAndThrowOnCycles() {
		const inDegree = this.jobs.slice(0, this.jobCounter).map(job => job.dependencyCounter)
		const queue = []

		// Initialize the queue with all jobs that have no prerequisites.
		for (let i = 0; i < this.jobCounter; i++) {
			if (inDegree[i] === 0) {
				queue.push(i)
			}
		}

		let visitedCount = 0
		while (queue.length > 0) {
			const jobId = queue.shift()
			visitedCount++

			const job = this.jobs[jobId]
			// Traverse the linked list of dependents.
			let currentNodeIndex = job.dependentsHead
			while (currentNodeIndex !== -1) {
				const node = this.dependencyNodePool[currentNodeIndex]
				const dependentId = node.dependentId
				inDegree[dependentId]--
				if (inDegree[dependentId] === 0) {
					queue.push(dependentId)
				}
				currentNodeIndex = node.next
			}
		}

		if (visitedCount < this.jobCounter) {
			// A cycle exists. Find and report it.
			const cycle = this._findCyclePath(inDegree)
			throw new Error(
				`[Scheduler] Circular dependency detected! The following systems form a cycle: ${cycle.join(' -> ')}`,
			)
		}
	}

	/**
	 * Helper to find one of the cycles in the graph for error reporting.
	 * @param {number[]} inDegree - The remaining in-degrees after the failed topo-sort.
	 * @returns {string[]} A list of system names forming the cycle.
	 * @private
	 */
	_findCyclePath(inDegree) {
		const path = []
		const visited = new Set()
		let currentJobId = inDegree.findIndex(d => d > 0)

		while (currentJobId !== -1 && !visited.has(currentJobId)) {
			visited.add(currentJobId)
			// Look up the system name from its ID for the error message.
			const systemName = this.systemManager.getSystemNameById(this.jobs[currentJobId].systemId)
			path.push(systemName)
			// Find a dependent that is also part of the cycle.
			let foundDependent = -1
			let currentNodeIndex = this.jobs[currentJobId].dependentsHead
			while (currentNodeIndex !== -1) {
				const depId = this.dependencyNodePool[currentNodeIndex].dependentId
				if (inDegree[depId] > 0) foundDependent = depId
				currentNodeIndex = this.dependencyNodePool[currentNodeIndex].next
			}
			currentJobId = foundDependent
		}
		if (currentJobId !== -1) path.push(this.jobs[currentJobId].systemName) // Close the loop
		return [...new Set(path)] // Deduplicate system names for clarity
	}

	/**
	 * (DEBUG) Retrieves human-readable information about a specific job from the SAB.
	 * This is useful for logging and debugging, as it can be called from the main thread
	 * to understand what job a worker is referring to by its ID.
	 * @param {number} jobId The ID of the job to inspect.
	 * @returns {object | null} An object with job details, or null if the job ID is invalid.
	 */
	getJobInfo(jobId) {
		if (jobId < 0 || jobId >= this.jobCounter) {
			return null // Invalid job ID
		}

		const jobsView = new Int32Array(this.sharedBuffers.jobsSAB)
		const jobOffset = jobId * JOB_STRIDE_IN_U32

		// Read the raw data back from the SAB.
		const systemId = jobsView[jobOffset + JOB_SYSTEM_ID_OFFSET]
		const jobPayload = jobsView[jobOffset + JOB_PAYLOAD_OFFSET]

		// Unpack the data into a human-readable format.
		const systemName = this.systemManager.getSystemNameById(systemId)
		const jobTypeNum = jobPayload >> 24
		const payload = jobPayload & 0x00ffffff

		const jobTypeName = jobTypeNum === JOB_TYPE.KERNEL ? 'kernel' : JOB_TYPE_TO_METHOD_NAME[jobTypeNum] || 'unknown'
		const info = { jobId, systemName, jobType: jobTypeName }
		if (jobTypeNum === JOB_TYPE.KERNEL) info.payload = payload
		return info
	}
}
