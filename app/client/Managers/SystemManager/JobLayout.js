// --- Shared Buffer Layout Constants ---
export const MAX_JOBS = 16384 // Max jobs per frame/group
export const MAX_DEPENDENTS = 65536 // Max total dependents across all jobs
export const MAX_THREADS = 16 // Max total threads (main + workers)

export const CACHE_LINE_SIZE = 64 // In bytes, for padding to avoid false sharing
export const JOB_STRIDE_IN_BYTES = CACHE_LINE_SIZE * 2 // 128 bytes
export const JOB_STRIDE_IN_U32 = JOB_STRIDE_IN_BYTES / 4 // 32

// --- Job Data Layout (within the 64-byte stride) ---
// --- "Cold" Data (written once, read by one thread at a time) ---
// This data is grouped at the beginning of the cache line.
export const JOB_AFFINITY_OFFSET = 0 // Determines which thread type can run the job.
export const JOB_PAYLOAD_OFFSET = 1 // Packed: jobType, chunkId
export const JOB_DEP_LIST_START_OFFSET = 2 // Start index in dependentsSAB
export const JOB_DEP_LIST_COUNT_OFFSET = 3 // Number of dependents in the list
export const JOB_SYSTEM_ID_OFFSET = 4 // ID of the system this job belongs to
export const JOB_KERNEL_ID_OFFSET = 5 // ID of the kernel to execute for KERNEL jobs.

// --- "Hot" Data (written frequently by many threads) ---.
// The dependency counter is the single "hot" field, as many threads may try to
// decrement it concurrently. By placing it on its own cache line within the
// 128-byte stride, we completely eliminate false sharing between the hot counter
// and the cold data of the same job, as well as between adjacent jobs.
export const JOB_DEP_COUNTER_OFFSET = 16 // 16 * 4 bytes = 64 byte offset

/**
 * Enum for the different types of jobs the scheduler can handle.
 */
export const JOB_TYPE = {
	UPDATE: 0, // Main-thread job that runs before parallel work.
	KERNEL: 1, // Parallel kernel job that can run on any thread.
	PROCESS: 2, // Main-thread job that runs after parallel work.
}

/**
 * Enum for job affinity, determining which thread(s) can execute a job.
 */
export const JOB_AFFINITY = {
	ANY_WORKER: 0, // Can run on any thread (main or worker).
	MAIN_THREAD: 1, // Must run on the main thread.
}