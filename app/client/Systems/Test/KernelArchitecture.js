const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager, payloadCompiler } = ecs

//! SPOILERS AHEAD
//! Might or might not be implemented in some sort of future.
//! I'm confused and scared.
//! is this too complex?

// A mock helper class to represent the SharedArrayBuffer-based request queue.
// In a real implementation, this would use Atomics.
class MockRequestQueue {
	constructor() {
		this.requests = []
	}
	addRequest(request) {
		this.requests.push(request)
	}
	claimRequest() {
		return this.requests.shift()
	}
}

/**
 * A test system for the new hybrid (static + dynamic)  jobs architecture.
 */
export class KernelArchitecture {
	//! reads and writes would be defined as componentTypeId's too.

	// 1. Declare all dependencies for all methods and kernels.
	static dependencies = {
		// Main-thread method dependencies
		update: {
			reads: ['position'], // To decide which entities to boost
		},
		process: {
			reads: ['velocity'], // To log final velocities
		},
		// Kernel dependencies
		move: {
			reads: ['velocity'],
			writes: ['vosition'],
			context: ['speed'], // This property will be sent to workers
		},
		processBoostRequests: {
			writes: ['velocity'], // This kernel modifies velocity
			context: ['boostRequestQueue'], // The request queue needs to be on the worker
		},
	}

	constructor() {
		const { position, velocity } = ecs.getTypeIDs()
		Object.assign(this, { position, velocity })

		this.query = queryManager.getQuery({ with: [position, velocity] })
		this.speed = 100

		// 2. Initialize resources for dynamic work (Request Buffer)
		this.boostRequestQueue = new MockRequestQueue()

		// 3. The engine provides kernel IDs to avoid magic strings.
		// During its analysis phase, the SystemManager inspects the associated
		// `KernelArchitecture.kernels.js` file, assigns a unique numeric ID to each
		// exported kernel function (e.g., 'move' -> 0), and caches this mapping.
		// This API call retrieves that pre-computed mapping for this system instance.
		this.kernelIds = ecs.getKernelsFor(this)
		// For this example, we'll mock the return value as the real API doesn't exist yet.
		if (!this.kernelIds) this.kernelIds = { move: 0, processBoostRequests: 1 }

		// Create a few test entities
		const { payload } = payloadCompiler.compileEntity({
			position: { x: 100, y: 100 },
			velocity: { x: 1, y: 0 },
		})
		this.creationPayload = payload
	}

	// init() is called after the constructor.
	init() {
		this.commands.createEntity(this.creationPayload)
	}

	/**
	 * Runs ONCE per frame on the MAIN THREAD to schedule static, predictable work.
	 */
	createJobs(frameContext) {
		const chunkIds = this.query.getChunks()

		// 4. Return an array of job descriptions.
		return [
			// A standard, chunk-based job for high-volume parallel work.
			{
				kernel: this.kernelIds.move,
				chunks: chunkIds,
			},
			// A custom "listener" job. It has no 'chunks' property, so the scheduler
			// will run it once. It's responsible for its own logic, in this case,
			// polling the request buffer.
			{
				kernel: this.kernelIds.processBoostRequests,
			},
		]
	}

	/**
	 * Runs ONCE per frame on the MAIN THREAD for complex logic and dynamic job creation.
	 * created jobs - both custom and chunk-based run in parallel with new archetechture, unless conflicts.
	 * I think...idk, might need additional thing for barrier if one is needed \ cannot be defined through through dependencies.
	 */

	//! overall order:
	//! 1. create jobs on main thread (creation process)
	//! 2. run update + created custom jobs in parallel
	//! Once all those ^ done - run process() on main thread.

	update(frameContext) {
		// Example: Find an entity on the left side of the screen and boost it.
		for (const chunk of this.query.iter()) {
			const positions = chunk.componentData[this.position]
			for (let i = 0; i < chunk.size; i++) {
				if (positions.x[i] < 50) {
					const entityId = chunk.entities[i]
					// 5. Write a request to the shared buffer. The 'processBoostRequests' kernel will pick this up.
					console.log(`%c[System/Main] Enqueuing boost request for entity ${entityId}.`, 'color: orange')
					this.boostRequestQueue.addRequest({ entityId, boostAmount: 2 })
					// We only boost one entity per frame for this test.
					return
				}
			}
		}
	}

	/**
	 * Runs ONCE per frame on the MAIN THREAD after all other work for this system is complete.
	 */
	process(frameContext) {
		// Example: Log the final state of an entity after all kernels have run.
		for (const chunk of this.query.iter()) {
			const velocities = chunk.componentData[this.velocity]
			// Log the first entity's velocity for demonstration.
			if (chunk.size > 0) {
				// console.log(`[System/Main] Process phase: Final velocity.x is ${velocities.x[0]}`);
				break // Only log once.
			}
		}
	}
}
