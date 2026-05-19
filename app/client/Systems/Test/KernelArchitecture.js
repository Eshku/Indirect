const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { position, velocity } = ecs.getComponentIDs()
// Use camelCase for all ID lookups for consistency.
// Kernels are functions, so we use camelCase. Let's get all the ones we need.
const { testKernel, loggingKernel } = ecs.getKernelIDs()

// Systems are classes, so we use PascalCase.
const { PlayerInputSystem } = ecs.getSystemIDs()

// Module-level constants are the preferred way to define static context data.
const KERNEL_SPEED = 100

// --- Test State for Execution Order ---
// These are module-level so they can be referenced in the static context.
const executionLog = new Int32Array(new SharedArrayBuffer(4 * 5)) // 5 slots
const logIndex = new Int32Array(new SharedArrayBuffer(4))
Atomics.store(logIndex, 0, 0)

/**
 * A test system for the new hybrid (static + dynamic) jobs architecture.
 */
export class KernelArchitecture {
	static dependencies = {
		// --- Kernel Dependencies ---

		// The scheduler has an implicit rule: all KERNEL jobs for a system
		// will wait for that system's UPDATE job to complete.
		// This ensures a predictable `update -> kernel` execution flow.
		// Therefore, 'testKernel' will run AFTER 'update'.
		testKernel: {
			reads: velocity,
			writes: position,
			context: {
				speed: KERNEL_SPEED,
				position,
				velocity,
				executionLog,
				logIndex,
			},
		},

		// 'loggingKernel' also implicitly depends on 'update' due to the
		// scheduler's local phase dependency rule. No explicit `runsAfter` is needed.
		loggingKernel: {
			context: {
				executionLog,
				logIndex,
			},
		},

		// --- Main-thread finalizer ---
		// The 'process' job has an implicit dependency on all other jobs in the
		// same system (`update` and all `kernels`). It is guaranteed to run last.
		process: {
			reads: velocity,
		},
	}

	// init() is called after the constructor.
	init() {
		this.query = this.getQuery({ with: [position, velocity] })

		this.creationPayload = this.compile({
			position: { x: 100, y: 100 },
			velocity: { x: 1, y: 0 },
		})
		this.instantiate(this.creationPayload, 1)
	}

	update(frameContext) {
		// Reset log periodically to see fresh results.
		if (frameContext.currentVersion > 0 && frameContext.currentVersion % 60 === 0) {
			Atomics.store(logIndex, 0, 0)
			executionLog.fill(0)
		}

		// --- Simulate a heavier workload to test parallelism ---
		// This busy-wait gives worker threads a chance to start their
		// `testKernel` job before this `update` job finishes.
		const start = performance.now()
		while (performance.now() - start < 2) {
			// Burn CPU for ~2ms
		}

		const index = Atomics.add(logIndex, 0, 1)
		if (index < executionLog.length) {
			Atomics.store(executionLog, index, 1) // 1 for update
		}
	}

	/**
	 * Runs ONCE per frame on the MAIN THREAD to create jobs for static, predictable work.
	 * @param {import('../../Managers/SystemManager/JobWriter.js').JobWriter} jobWriter
	 */
	schedule(jobWriter) {
		// Schedule a job for each chunk to be processed by the main kernel.
		jobWriter.scheduleForEachChunk(this.query, testKernel)

		// Schedule a single custom job for the logging kernel.
		jobWriter.scheduleCustom(loggingKernel, 0) // Payload is unused
	}

	/**
	 * Runs ONCE per frame on the MAIN THREAD after all other work for this system is complete.
	 */
	process(frameContext) {
		// --- Verify Execution Order ---
		// Check on the frame after a reset to ensure we have a full log.
		if (frameContext.currentVersion > 0 && frameContext.currentVersion % 60 === 1) {
			const finalLogIndex = Atomics.load(logIndex, 0)
			const log = Array.from(executionLog).slice(0, finalLogIndex)

			// Map numeric codes to human-readable names for logging.
			const phaseNames = { 1: 'update', 2: 'testKernel', 3: 'loggingKernel' }
			const namedLog = log.map(code => phaseNames[code] || `unknown(${code})`)

			const updateIdx = log.indexOf(1)
			const testKernelIdx = log.indexOf(2)
			const loggingKernelIdx = log.indexOf(3)

			let success = true
			let message = `Execution Order: [${namedLog.join(', ')}]`

			if (updateIdx === -1 || testKernelIdx === -1 || loggingKernelIdx === -1) {
				success = false
				message += ` | FAILED: Not all phases ran. Expected [update, testKernel, loggingKernel] to be present.`
			} else if (loggingKernelIdx < updateIdx || testKernelIdx < updateIdx) {
				// This check is now the core of the test
				success = false
				message += ` | FAILED: A kernel ran before 'update'. The implicit 'update' -> 'kernel' dependency was not respected.`
			} else {
				message += ` | PASSED: All kernels ran after 'update' as required by the simplified intra-system dependency model.`
			}

			if (success) {
				console.log(`%c[KernelArchitecture] ${message}`, 'color: lightgreen')
			} else {
				console.error(`[KernelArchitecture] ${message}`)
			}
		}
	}
}
