// The frame state buffer uses 64-bit integers (BigInt64) for all counters to prevent overflow.
// Each counter is on its own cache line (64 bytes). A BigInt64 is 8 bytes.
// So the stride between counters is 8 (8 * 8 = 64 bytes).
export const FRAME_STATE_TOTAL_JOBS_OFFSET = 0
export const FRAME_STATE_COMPLETED_JOBS_OFFSET = 8
export const FRAME_STATE_IDLE_THREADS_OFFSET = 16
export const FRAME_STATE_BARRIER_COUNTER_OFFSET = 24
export const FRAME_STATE_BARRIER_GENERATION_OFFSET = 32
export const FRAME_STATE_SLEEP_GENERATION_OFFSET = 40
export const FRAME_STATE_FRAME_GENERATION_OFFSET = 48