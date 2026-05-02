const entityStore = {}

class WorkerEntry {
	constructor() {
		// --- Layout Constants (will be populated in init) ---
		this.FRAME_STATE_TOTAL_JOBS_OFFSET = 0
		this.FRAME_STATE_COMPLETED_JOBS_OFFSET = 0
		this.FRAME_STATE_IDLE_THREADS_OFFSET = 0
		this.FRAME_STATE_BARRIER_COUNTER_OFFSET = 0
		this.FRAME_STATE_BARRIER_GENERATION_OFFSET = 0
		this.FRAME_STATE_SLEEP_GENERATION_OFFSET = 0
		this.FRAME_STATE_FRAME_GENERATION_OFFSET = 0
		this.FRAME_CONTEXT_FRAME_ID_OFFSET = 0
		this.FRAME_CONTEXT_CURRENT_TICK_OFFSET = 0
		this.FRAME_CONTEXT_LAST_TICK_OFFSET = 0
		this.FRAME_CONTEXT_DELTA_TIME_OFFSET = 0
		this.FRAME_CONTEXT_ALPHA_OFFSET = 0
		this.JOB_AFFINITY_OFFSET = 0
		this.JOB_PAYLOAD_OFFSET = 0
		this.JOB_DEP_LIST_START_OFFSET = 0
		this.JOB_DEP_LIST_COUNT_OFFSET = 0
		this.JOB_SYSTEM_ID_OFFSET = 0
		this.JOB_KERNEL_ID_OFFSET = 0
		this.JOB_DEP_COUNTER_OFFSET = 0
		this.JOB_TYPE = {}
		this.JOB_AFFINITY = {}
		this.NO_JOB_AVAILABLE = -1
		this.JOB_STRIDE_IN_U32 = 0

		// --- Worker State ---
		this.isInitialized = false
		this.logicRegistry = {}
		this.localDeque = null
		this.mainThreadInbox = null
		this.allDeques = []
		this.importFromString = null
		this.hashFn = null // To store the h64 function
		this.archetypeMap = null
		this.spatialHashGrid = null

		// --- Reusable Arrays to Reduce GC Pressure ---
		// These are used in hot paths to avoid allocating new arrays on every job.
		this.reusableUnlockedMTOJobs = []
		this.reusableUnlockedAnyJobs = []
		this.scratchBuffer = null
		this.DIRTY_HISTORY_LENGTH = 0
		this.reusableStealBuffer = []

		this.jobs = null
		this.dependents = null
		this.frameState = null

		// --- Reusable TypedArray Views to Reduce GC Pressure ---
		this.jobsView = null
		this.dependentsView = null
		this.frameContextI64View = null
		this.frameContextF64View = null

		this.idToSystemName = {}
		this.totalThreads = 0
		this.maxDequeCapacity = 0

		this.currentFrameId = -1
		this.currentTick = -1

		// This is now a global, read-only object for kernels.
		self.frameContext = {}
		this.systemContexts = {} // Static, system-specific contexts.
		this.kernelContext = null

		self.onmessage = this.handleMessage.bind(this)
	}

	async init(payload) {
		if (this.isInitialized) {
			console.error('[Worker] Worker is already initialized.')
		}

		const {
			workerId,
			baseUrl,
			jobsSAB,
			dependentsSAB,
			frameStateSAB,
			frameContextSAB,
			mainThreadInbox,
			dequeBuffers,
			spatialHashGridSABs,
			sharedData,
			kernelCode,
			kernelMetadata,
			initialChunks,
			systemIdMap,
			totalThreads,
		} = payload
		this.totalThreads = totalThreads

		self.id = payload.workerId

		// These are the raw, empty container arrays. They will be populated by syncChunks.
		entityStore.archetypeMasks = new BigUint64Array(sharedData.archetypeMasks)
		entityStore.archetypeComponentCounts = new Uint16Array(sharedData.archetypeComponentCounts)
		entityStore.archetypeChunkCounts = new Uint16Array(sharedData.archetypeChunkCounts)
		entityStore.archetypeHeadChunkIds = new Uint16Array(sharedData.archetypeHeadChunkIds)
		entityStore.archetypeTailChunkIds = new Uint16Array(sharedData.archetypeTailChunkIds)
		entityStore.archetypeLastNonFullChunkId = new Uint16Array(sharedData.archetypeLastNonFullChunkId)
		entityStore.archetypeComponentListStartIndices = new Uint32Array(sharedData.archetypeComponentListStartIndices)
		entityStore.packedComponentIdPages = sharedData.packedComponentIdPageSABs.map(sab => new Uint16Array(sab))

		entityStore.chunkComponentData = new Array(sharedData.MAX_CHUNKS)
		entityStore.chunkDirtyTicks = new Array(sharedData.MAX_CHUNKS)
		entityStore.chunkArchetypeDirtyTicks = sharedData.chunkArchetypeDirtyTicks
		entityStore.chunkArchetypeIds = new Uint16Array(sharedData.chunkArchetypeIds)
		entityStore.chunkSizes = new Uint16Array(sharedData.chunkSizes)
		entityStore.chunkCapacities = new Uint16Array(sharedData.chunkCapacities)
		entityStore.chunkPrevInArchetype = new Uint16Array(sharedData.chunkPrevInArchetype)
		entityStore.chunkNextInArchetype = new Uint16Array(sharedData.chunkNextInArchetype)


		entityStore.chunkMetadata = sharedData.chunkMetadata
		this.syncChunkDeltas({ newChunks: initialChunks })

		this.jobs = jobsSAB
		this.dependents = dependentsSAB
		this.jobsView = new Int32Array(this.jobs)
		this.dependentsView = new Uint32Array(this.dependents)
		this.frameState = new BigInt64Array(frameStateSAB)
		this.frameContextI64View = new BigInt64Array(frameContextSAB)
		this.frameContextF64View = new Float64Array(frameContextSAB)

		for (const name in systemIdMap) {
			const id = systemIdMap[name]
			this.idToSystemName[id] = name
		}

		this.kernelMetadata = kernelMetadata
		const jobLayoutModuleUrl = new URL('../../Managers/SystemManager/JobLayout.js', baseUrl)
		const frameStateLayoutModuleUrl = new URL('../../Managers/SystemManager/FrameStateLayout.js', baseUrl)

		try {
			const blobUtilModuleUrl = new URL('../../Core/utils/blob.js', baseUrl)
			const mpscQueueModuleUrl = new URL('../../Core/Algorithms/MPSCQueue.js', baseUrl)
			const dequeModuleUrl = new URL('../../Core/Algorithms/WorkStealingDeque.js', baseUrl)
			const componentSchemaModuleUrl = new URL('../../Managers/ComponentManager/ComponentSchema.js', baseUrl)
			const archetypeHashMapModuleUrl = new URL('../../Core/DataStructures/SharedArchetypeHashMap.js', baseUrl)
			const xxhashWasmModuleUrl = new URL('../../../../node_modules/xxhash-wasm/esm/xxhash-wasm.js', baseUrl)
			const kernelAPIModuleUrl = new URL('./Kernel.js', baseUrl)
			const spatialHashGridModuleUrl = new URL('../../Core/DataStructures/SpatialHashGrid.js', baseUrl)

			const [
				blobUtilModule,
				mpscQueueModule,
				dequeModule,
				jobLayoutModule,
				frameStateLayoutModule,
				spatialHashGridModule,
				componentSchemaModule,
				archetypeHashMapModule,
				xxhashModule,
				kernelAPIModule,
			] = await Promise.all([
				import(blobUtilModuleUrl.href),
				import(mpscQueueModuleUrl.href),
				import(dequeModuleUrl.href),
				import(jobLayoutModuleUrl.href),
				import(frameStateLayoutModuleUrl.href),
				import(spatialHashGridModuleUrl.href),
				import(componentSchemaModuleUrl.href),
				import(archetypeHashMapModuleUrl.href),
				import(xxhashWasmModuleUrl.href),
				import(kernelAPIModuleUrl.href),
			])

			Object.assign(this, jobLayoutModule)
			Object.assign(this, frameStateLayoutModule)

			// Quick verification
			if (this.JOB_TYPE.KERNEL === undefined) {
				throw new Error('Failed to load JobLayout constants.')
			}
			if (this.FRAME_STATE_TOTAL_JOBS_OFFSET === undefined) {
				// This is checking for a number, which can be 0, so `undefined` is the right check.
				throw new Error('Failed to load FrameStateLayout constants.')
			}

			const { importFromString } = blobUtilModule
			const { MPSCQueue } = mpscQueueModule
			const { WorkStealingDeque, NO_JOB_AVAILABLE } = dequeModule
			const { SpatialHashGrid } = spatialHashGridModule
			const { SharedArchetypeHashMap } = archetypeHashMapModule
			const xxhashDefault = xxhashModule.default
			const { h64Raw } = await xxhashDefault()
			this.hashFn = h64Raw

			this.importFromString = importFromString

			this.NO_JOB_AVAILABLE = NO_JOB_AVAILABLE
			this.DIRTY_HISTORY_LENGTH = componentSchemaModule.DIRTY_HISTORY_LENGTH

			this.archetypeMap = new SharedArchetypeHashMap(sharedData.archetypeMapBuffer, this.hashFn)

			// Load all kernel modules.
			for (const moduleName in kernelCode) {
				const code = kernelCode[moduleName]
				// Use importFromString to load the module from its source code string.
				const kernelModule = await this.importFromString(code)
				this.logicRegistry[moduleName] = kernelModule
			}

			// Make the parallel API globally available to all kernels in this worker.
			self.kernel = new kernelAPIModule.Kernel({ entityStore })
			this.spatialHashGrid = new SpatialHashGrid(spatialHashGridSABs)
			self.spatialHashGrid = this.spatialHashGrid // Make it available on the global worker scope so kernels can access it.

			// All workers get a handle to the same MPSC queue to send jobs to the main thread.
			this.mainThreadInbox = new MPSCQueue(mainThreadInbox)

			// Pre-create and cache deque instances for all threads.
			this.allDeques = []
			for (let i = 0; i < this.totalThreads; i++) {
				this.allDeques.push(new WorkStealingDeque(dequeBuffers[i]))
			}
			// The worker's own deque is at its ID index in the allDeques array.
			this.localDeque = this.allDeques[self.id]

			// Initialize the scratch buffer. Max chunk capacity is not fixed, but 16KB is the target.
			// A capacity of 4096 entities should be safe.
			this.scratchBuffer = new Uint32Array(2048) //! once store is separated can import, although whole thing most likely gonna change.

			this.kernelContext = {
				getScratchBuffer: () => this.scratchBuffer,
			}
		} catch (e) {
			console.error(`[Worker ${self.id}] Failed during dynamic module import or initialization:`, e)
			throw e
		}
		this.isInitialized = true
		self.postMessage({ type: 'ready' })
	}

	async mainLoop() {
		let frameGeneration = Atomics.load(this.frameState, this.FRAME_STATE_FRAME_GENERATION_OFFSET)

		while (true) {
			// Asynchronously wait for the main thread to signal a new frame.
			// This does not block the worker's event loop, so it can still
			// process other messages like HMR updates or chunk syncs.
			await Atomics.waitAsync(this.frameState, this.FRAME_STATE_FRAME_GENERATION_OFFSET, frameGeneration).value

			// Woke up, a new frame is ready. Update our generation counter.
			frameGeneration = Atomics.load(this.frameState, this.FRAME_STATE_FRAME_GENERATION_OFFSET)

			// Read the new context data from the shared buffer.
			this._updateSharedFrameContext()

			// Process all jobs for this frame.
			await this.processFrame()
		}
	}

	_updateSharedFrameContext() {
		this.currentFrameId = Number(this.frameContextI64View[this.FRAME_CONTEXT_FRAME_ID_OFFSET])
		this.currentTick = Number(this.frameContextI64View[this.FRAME_CONTEXT_CURRENT_TICK_OFFSET])

		// Update the global frameContext object that kernels will access.
		self.frameContext.currentTick = this.currentTick
		self.frameContext.lastTick = Number(this.frameContextI64View[this.FRAME_CONTEXT_LAST_TICK_OFFSET])
		self.frameContext.deltaTime = this.frameContextF64View[this.FRAME_CONTEXT_DELTA_TIME_OFFSET]
		self.frameContext.alpha = this.frameContextF64View[this.FRAME_CONTEXT_ALPHA_OFFSET]
	}

	async handleMessage(event) {
		const { type, ...payload } = event.data

		try {
			if (!this.isInitialized && type !== 'init') {
				throw new Error(`[Worker] Received job type '${type}' before initialization.`)
			}

			switch (type) {
				case 'init':
					await this.init(payload)
					// Now that init is done, start the main loop.
					// We don't await it because it's an infinite loop, but it will
					// yield to the event loop via `await Atomics.waitAsync`.
					this.mainLoop()
					return
				case 'init-contexts':
					// This message contains the initial static context for all parallel systems.
					this.systemContexts = payload.systemContexts || {}
					return
				case 'hmr-kernel-update':
					// Future: Implement HMR for kernel modules.
					// await this.loadKernelModule(payload)
					return
				case 'hmr-context-update':
					// A single kernel's static context has been updated via HMR.
					if (!this.systemContexts[payload.systemId]) {
						this.systemContexts[payload.systemId] = {}
					}
					this.systemContexts[payload.systemId][payload.kernelId] = payload.context
					return
				case 'sync-chunk-deltas':
					this.syncChunkDeltas(payload)
					return
				case 'sync-archetype-store-pages':
					for (const pageSAB of payload.pages) {
						entityStore.packedComponentIdPages.push(new Uint16Array(pageSAB))
					}
					return
				case 'archetype-map-resize':
					// The main thread has resized the map. We just need to point our instance to the new buffer.
					this.archetypeMap = new this.archetypeMap.constructor(payload.archetypeMapBuffer, this.hashFn)
					return
				default:
					throw new Error(`[Worker] Unknown job type: ${type}`)
			}
		} catch (e) {
			console.error(`[Worker ${self.id}] Error processing message type '${type}':`, e)
			self.postMessage({
				type: 'job_error',
				error: e.message,
			})
		}
	}

	async processFrame() {
		let totalJobs = Atomics.load(this.frameState, this.FRAME_STATE_TOTAL_JOBS_OFFSET)
		let completedJobs = Atomics.load(this.frameState, this.FRAME_STATE_COMPLETED_JOBS_OFFSET)
		const frameId = this.currentFrameId

		while (completedJobs < totalJobs) {
			const jobId = this.findJob(self.id)

			if (jobId !== this.NO_JOB_AVAILABLE) {
				this.executeJob(jobId, self.id, frameId)
			} else {
				// No job found. Go to sleep until woken up.
				await this.goToSleep(frameId)
			}
			// Re-check job counts after potentially doing work or yielding.
			totalJobs = Atomics.load(this.frameState, this.FRAME_STATE_TOTAL_JOBS_OFFSET)
			completedJobs = Atomics.load(this.frameState, this.FRAME_STATE_COMPLETED_JOBS_OFFSET)
		}

		// --- End-of-Frame Barrier ---
		// All jobs are done. This worker must now wait for all other threads to finish.
		const counterOffset = this.FRAME_STATE_BARRIER_COUNTER_OFFSET
		const generationOffset = this.FRAME_STATE_BARRIER_GENERATION_OFFSET

		// 1. Capture the current barrier generation.
		const myGeneration = Atomics.load(this.frameState, generationOffset)

		// 2. Atomically increment the counter of threads at the barrier.
		const count = Atomics.add(this.frameState, counterOffset, 1n) + 1n

		if (count === BigInt(this.totalThreads)) {
			// 3a. I am the LAST thread. Reset the counter for the next frame.
			Atomics.store(this.frameState, counterOffset, 0n)
			// 3b. Increment the generation to release the waiting threads.
			Atomics.add(this.frameState, generationOffset, 1n)
			// 3c. Notify all waiting threads that the generation has changed.
			Atomics.notify(this.frameState, generationOffset, this.totalThreads - 1)
		} else {
			// 4. I am NOT the last thread. Wait for the generation to change.
			// The wait is in a loop to handle spurious wakeups.
			while (Atomics.load(this.frameState, generationOffset) === myGeneration) {
				Atomics.wait(this.frameState, generationOffset, myGeneration)
			}
		}
	}

	async goToSleep(frameId) {
		const idleOffset = this.FRAME_STATE_IDLE_THREADS_OFFSET
		const generationOffset = this.FRAME_STATE_SLEEP_GENERATION_OFFSET

		// Capture the sleep generation *before* the final check for work.
		// This is critical to closing a race condition where a wakeup signal could be
		// missed between the final check and the call to Atomics.wait.
		const myGeneration = Atomics.load(this.frameState, generationOffset)

		// Increment the idle counter to signal our intent to sleep.
		Atomics.add(this.frameState, idleOffset, 1n)

		// --- Last check for work OR completion before sleeping ---

		// Check 1: Is the frame already done?
		const totalJobs = Atomics.load(this.frameState, this.FRAME_STATE_TOTAL_JOBS_OFFSET)
		const completedJobs = Atomics.load(this.frameState, this.FRAME_STATE_COMPLETED_JOBS_OFFSET)
		if (completedJobs >= totalJobs) {
			// The frame finished while we were preparing to sleep. Abort sleep.
			Atomics.sub(this.frameState, idleOffset, 1n)
			return // Exit, main loop will terminate and go to barrier.
		}

		// Check 2: Did a new job appear?
		const finalCheckJobId = this.findJob(self.id)
		if (finalCheckJobId !== this.NO_JOB_AVAILABLE) {
			// A job appeared! Decrement the idle counter and execute the job instead of sleeping.
			// This is a normal race-avoidance path, so no log is needed.
			// We are no longer idle, so decrement the counter and execute the job.
			Atomics.sub(this.frameState, idleOffset, 1n)
			this.executeJob(finalCheckJobId, self.id, frameId)
			return
		}

		// Go to sleep, waiting for the generation to change.
		// The loop handles spurious wakeups.
		while (Atomics.load(this.frameState, generationOffset) === myGeneration) {
			Atomics.wait(this.frameState, generationOffset, myGeneration)
		}
		// We have woken up and are no longer idle. Decrement the counter.
		Atomics.sub(this.frameState, idleOffset, 1n)
	}

	/**
	 * Wakes up a specified number of sleeping threads (main or worker).
	 * This is called when new work becomes available that an idle thread could potentially pick up.
	 */
	wakeIdleThreads(count = Infinity) {
		const idleOffset = this.FRAME_STATE_IDLE_THREADS_OFFSET
		const generationOffset = this.FRAME_STATE_SLEEP_GENERATION_OFFSET

		// Optimization: Only notify if there are actually threads waiting.
		const idleCount = Atomics.load(this.frameState, idleOffset)
		if (idleCount > 0n) {
			// Increment the generation to signal a wakeup event.
			Atomics.add(this.frameState, generationOffset, 1n)
			// Notify ALL threads waiting on the generation counter to avoid lost wakeups
			// where a worker consumes a notification intended for another thread.
			Atomics.notify(this.frameState, generationOffset, count)
		}
	}

	/**
	 * Finds a job for this worker to execute.
	 * It first tries to pop from its own deque, then attempts to steal.
	 * @param {number} threadId - The ID of this worker thread.
	 * @returns {number} The ID of the found job, or -1 if no job is available.
	 */
	findJob(threadId) {
		// Always check the local queue first. This is the most common and fastest path.
		// This also solves a race condition where a job is pushed right before we go to sleep.
		const localJob = this.localDeque.pop()
		if (localJob !== this.NO_JOB_AVAILABLE) {
			return localJob
		}

		// If the local queue is empty, try to steal from other threads.
		if (this.totalThreads <= 1) return this.NO_JOB_AVAILABLE

		// --- Ring Neighbor-First Stealing Strategy ---
		// Worker `i` attempts to steal from `(i+1)%N`, then `(i+2)%N`, etc.
		for (let i = 1; i < this.totalThreads; i++) {
			const victimId = (self.id + i) % this.totalThreads
			const victimDeque = this.allDeques[victimId]

			this.reusableStealBuffer.length = 0
			if (victimDeque.stealHalf(this.localDeque, this.reusableStealBuffer)) {
				// Steal was successful. Jobs are now in our local deque.
				// Pop one to execute immediately.
				const job = this.localDeque.pop()
				if (job !== this.NO_JOB_AVAILABLE) {
					return job
				}
				// If pop fails (highly unlikely race), just continue to next victim.
			}
		}

		return this.NO_JOB_AVAILABLE
	}

	executeJob(jobId, threadId, frameId) {
		if (jobId === undefined || jobId === null || jobId < 0) {
			return
		}

		const jobsView = this.jobsView
		const jobOffset = jobId * this.JOB_STRIDE_IN_U32
		const systemId = jobsView[jobOffset + this.JOB_SYSTEM_ID_OFFSET]
		const jobPayload = jobsView[jobOffset + this.JOB_PAYLOAD_OFFSET]

		const jobType = jobPayload >> 24
		const payload = jobPayload & 0x00ffffff;

		if (jobType === this.JOB_TYPE.KERNEL) {
			const kernelId = jobsView[jobOffset + this.JOB_KERNEL_ID_OFFSET]
			const kernelMeta = this.kernelMetadata.get(kernelId)
			if (!kernelMeta) {
				console.error(`[Worker ${self.id}] Could not find metadata for kernel ID ${kernelId}.`);
			} else {
				const { name: kernelName, moduleName } = kernelMeta
				const kernelFn = this.logicRegistry[moduleName]?.[kernelName]
				const systemContext = this.systemContexts[systemId]?.[kernelId]

				if (kernelFn) {
					try {
						self.kernel.resetJobState() // Reset pool for each job.
						kernelFn(payload, systemContext, this.kernelContext);
					} catch (error) {
						// Only look up system name on error.
						const systemName = this.idToSystemName[systemId]
						console.error(`[Worker ${self.id}] Error in kernel job for ${systemName}.${kernelName}:`, error)
					}
				} else {
					const systemName = this.idToSystemName[systemId]
					console.error(`[Worker ${self.id}] Could not find kernel function "${kernelName}" in module "${moduleName}" for system "${systemName}".`)
				}
		}
	}
		this.processDependents(jobId, threadId, frameId)

		const newCompletedJobs = Atomics.add(this.frameState, this.FRAME_STATE_COMPLETED_JOBS_OFFSET, 1n) + 1n
		const totalJobs = Atomics.load(this.frameState, this.FRAME_STATE_TOTAL_JOBS_OFFSET)

		if (newCompletedJobs >= totalJobs) {
			// This thread just completed the last job. It is responsible for waking up any
			// other threads that may have gone to sleep before realizing the frame was finished.
			// This prevents the "completion race" deadlock.
			this.wakeIdleThreads()
		}
	}

	processDependents(completedJobId, currentThreadId, frameId) {
		const jobsView = this.jobsView
		const dependentsView = this.dependentsView
		const jobOffset = completedJobId * this.JOB_STRIDE_IN_U32
		const depListStart = jobsView[jobOffset + this.JOB_DEP_LIST_START_OFFSET]
		const depListCount = jobsView[jobOffset + this.JOB_DEP_LIST_COUNT_OFFSET]

		// Reuse pre-allocated arrays to avoid GC pressure in this hot path.
		// This is a key optimization to prevent per-job allocations in a hot path.
		this.reusableUnlockedMTOJobs.length = 0
		this.reusableUnlockedAnyJobs.length = 0
		const unlockedMTOJobs = this.reusableUnlockedMTOJobs
		const unlockedAnyJobs = this.reusableUnlockedAnyJobs

		for (let i = 0; i < depListCount; i++) {
			const dependentJobId = dependentsView[depListStart + i]
			const dependentJobOffset = dependentJobId * this.JOB_STRIDE_IN_U32

			// Atomically decrement the counter and check if it reached zero.
			if (Atomics.sub(jobsView, dependentJobOffset + this.JOB_DEP_COUNTER_OFFSET, 1) === 1) {
				// The counter was 1 before we subtracted, so it's now 0.
				// This job is now ready to run. Read its routing info to decide where it goes.
				const affinity = jobsView[dependentJobOffset + this.JOB_AFFINITY_OFFSET]

				if (affinity === this.JOB_AFFINITY.MAIN_THREAD) {
					// This is a Main-Thread-Only job. Push it to the MPSC inbox.
					unlockedMTOJobs.push(dependentJobId)
				} else {
					// This is a parallel (ANY_WORKER) job. Push it to our own local deque.
					// This is the fast path, as we are the owner/producer.
					unlockedAnyJobs.push(dependentJobId)
				}
			}
		}

		for (const jobId of unlockedMTOJobs) {
			this.mainThreadInbox.push(jobId)
		}
		if (unlockedAnyJobs.length > 0) {
			this.localDeque.pushBatch(unlockedAnyJobs)
		}

		const unlockedMtoCount = unlockedMTOJobs.length
		const unlockedAnyCount = unlockedAnyJobs.length

		if (unlockedMtoCount > 0) {
			// If we unlocked a main-thread-only job, we MUST wake everyone to guarantee
			// the main thread wakes up. This is the "thundering herd" but is necessary for correctness.
			this.wakeIdleThreads(Infinity)
		} else if (unlockedAnyCount > 0) {
			// If we only unlocked parallel jobs, we can safely wake up a corresponding number of threads.
			this.wakeIdleThreads(unlockedAnyCount)
		}
	}

	syncChunkDeltas({ newChunks, destroyedChunks }) {
		if (destroyedChunks) {
			for (const chunkId of destroyedChunks) {
				entityStore.chunkComponentData[chunkId] = undefined
				entityStore.chunkDirtyTicks[chunkId] = undefined
				entityStore.chunkArchetypeDirtyTicks[chunkId] = undefined
			}
		}
		if (newChunks) {
			for (const chunkId in newChunks) {
				const chunkSyncData = newChunks[chunkId]
				entityStore.chunkComponentData[chunkId] = chunkSyncData.data
				entityStore.chunkDirtyTicks[chunkId] = chunkSyncData.ticks
				entityStore.chunkArchetypeDirtyTicks[chunkId] = chunkSyncData.archetypeTicks
				entityStore.chunkMetadata[chunkId] = chunkSyncData.metadata
			}
		}
	}
}

new WorkerEntry()
