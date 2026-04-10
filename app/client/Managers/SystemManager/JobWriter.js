const { entityStore } = await import(`@managers/EntityManager/EntityManager.js`)

import {
	JOB_STRIDE_IN_U32,
	JOB_AFFINITY_OFFSET,
	JOB_PAYLOAD_OFFSET,
	JOB_SYSTEM_ID_OFFSET,
	JOB_KERNEL_ID_OFFSET,
	JOB_TYPE,
	JOB_AFFINITY,
	MAX_JOBS,
} from './JobLayout.js'

//! throw it into extends too?

/**
 * A low-level, zero-allocation API for systems to schedule parallel jobs.
 * An instance of this class is passed to a system's `schedule()` method.
 * It writes job data directly into the Scheduler's pre-allocated SharedArrayBuffers,
 * bypassing intermediate object creation and garbage collection.
 */
export class JobWriter {
	/**
	 * @param {object} context The scheduler's context for this writer.
	 * @param {Int32Array} context.jobsView A view over the jobs SharedArrayBuffer.
	 * @param {number} context.jobCounter The current job counter.
	 * @param {number} context.systemId The ID of the system scheduling the jobs.
	 */
	constructor() {
		this.jobsView = null
		this.jobCounter = 0
		this.systemId = -1
	}

	/**
	 * Resets the writer with the context for a new system's schedule call.
	 * @param {object} context
	 */
	reset(context) {
		this.jobsView = context.jobsView
		this.jobCounter = context.jobCounter
		this.systemId = context.systemId
	}

	/**
	 * Schedules one job for each chunk in a query.
	 * This is an ergonomic helper for the most common parallel scheduling pattern.
	 * @param {import('../QueryManager/Query.js').Query} query The query whose chunks will be processed.
	 * @param {number} kernelId The numeric ID of the kernel to execute for each chunk.
	 */
	scheduleForEachChunk(query, kernelId) {
		const chunkIds = query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			// Check capacity on each job creation to prevent buffer overflow.
			if (this.jobCounter >= MAX_JOBS) {
				throw new Error(
					`[JobWriter] Exceeded MAX_JOBS (${this.jobCounter}/${MAX_JOBS}) while scheduling for system ${this.systemId}.`,
				)
			}

			const jobId = this.jobCounter
			const jobOffset = jobId * JOB_STRIDE_IN_U32
			const jobPayload = (JOB_TYPE.KERNEL << 24) | chunkId

			this.jobsView[jobOffset + JOB_AFFINITY_OFFSET] = JOB_AFFINITY.ANY_WORKER
			this.jobsView[jobOffset + JOB_PAYLOAD_OFFSET] = jobPayload
			this.jobsView[jobOffset + JOB_SYSTEM_ID_OFFSET] = this.systemId
			this.jobsView[jobOffset + JOB_KERNEL_ID_OFFSET] = kernelId

			this.jobCounter++
		}
	}

	/**
	 * The low-level method for scheduling any custom job.
	 * @param {number} kernelId The numeric ID of the kernel to execute.
	 * @param {number} payload A 24-bit integer payload for the kernel.
	 */
	scheduleCustom(kernelId, payload) {
		if (this.jobCounter >= MAX_JOBS) {
			// This check is critical to prevent writing out of bounds.
			throw new Error(`[JobWriter] Exceeded MAX_JOBS (${this.jobCounter}/${MAX_JOBS}).`)
		}

		const jobId = this.jobCounter

		// Write "cold" data directly to the SharedArrayBuffer. This is the writer's only job.
		const jobOffset = jobId * JOB_STRIDE_IN_U32
		const jobPayload = (JOB_TYPE.KERNEL << 24) | (payload || 0)

		this.jobsView[jobOffset + JOB_AFFINITY_OFFSET] = JOB_AFFINITY.ANY_WORKER
		this.jobsView[jobOffset + JOB_PAYLOAD_OFFSET] = jobPayload
		this.jobsView[jobOffset + JOB_SYSTEM_ID_OFFSET] = this.systemId
		this.jobsView[jobOffset + JOB_KERNEL_ID_OFFSET] = kernelId
		// Note: The dependency counter and list are written later by the Scheduler.

		this.jobCounter++
	}
}
