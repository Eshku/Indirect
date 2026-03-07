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

// --- Shared Frame Context Layout ---
export const FRAME_CONTEXT_FRAME_ID_OFFSET = 0 // BigInt64
export const FRAME_CONTEXT_CURRENT_TICK_OFFSET = 1 // BigInt64
export const FRAME_CONTEXT_LAST_TICK_OFFSET = 2 // BigInt64
export const FRAME_CONTEXT_DELTA_TIME_OFFSET = 3 // Float64, at byte offset 24
export const FRAME_CONTEXT_ALPHA_OFFSET = 4 // Float64, at byte offset 32