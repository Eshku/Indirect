// --- Shared Buffer Layout Constants ---
export const MAX_JOBS = 16384 // Max jobs per frame/group
export const MAX_DEPENDENTS = 65536 // Max total dependents across all jobs
export const MAX_THREADS = 16 // Max total threads (main + workers)

export const CACHE_LINE_SIZE = 64 // In bytes, for padding to avoid false sharing
export const JOB_STRIDE_IN_BYTES = CACHE_LINE_SIZE
export const JOB_STRIDE_IN_U32 = JOB_STRIDE_IN_BYTES / 4 // 16

// --- Job Data Layout (within the 64-byte stride) ---
// --- "Cold" Data (written once, read by one thread at a time) ---
// This data is grouped at the beginning of the cache line.
export const JOB_AFFINITY_OFFSET = 0 // Determines which thread type can run the job.
export const JOB_PAYLOAD_OFFSET = 1 // Packed: jobType, chunkId
export const JOB_DEP_LIST_START_OFFSET = 2 // Start index in dependentsSAB
export const JOB_DEP_LIST_COUNT_OFFSET = 3 // Number of dependents in the list
export const JOB_SYSTEM_ID_OFFSET = 4 // ID of the system this job belongs to

// The dependency counter is the "hot" field, frequently written to by multiple threads.
// We place it at a separate location within the 64-byte stride (at index 8, which is 32 bytes in)
// to minimize "false sharing" with the other read-only fields of the same job struct.
export const JOB_DEP_COUNTER_OFFSET = 8

/**
 * Enum for the different types of jobs the scheduler can handle.
 */
export const JOB_TYPE = {
	UPDATE: 0, // Main-thread job that runs before parallel work.
	SCHEDULE: 1, // Parallel job that can run on any thread.
	PROCESS: 2, // Main-thread job that runs after parallel work.
}

/**
 * Enum for job affinity, determining which thread(s) can execute a job.
 */
export const JOB_AFFINITY = {
	ANY_WORKER: 0, // Can run on any thread (main or worker).
	MAIN_THREAD: 1, // Must run on the main thread.
}