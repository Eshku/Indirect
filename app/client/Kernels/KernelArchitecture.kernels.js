/**
 * (Optional) One-time setup, runs once per worker when this module is first loaded.
 */
export function init(context) {
	console.log('KernelArchitecture kernels initialized on a worker.')
	// Can be used to set up complex objects from SABs, e.g., a pathfinding grid.
	return true // Signal success
}

/**
 * A static, chunk-based kernel that moves entities based on their velocity.
 */
export function move(chunk, systemContext) {
	// 'frameContext' is available in the worker's global scope, populated once per frame from a shared buffer.
	const { deltaTime } = frameContext
	const { speed } = systemContext // 'speed' is passed from the system instance.

	// In a real system, these would be looked up via ecs.getTypeIDs() on the main thread
	// and passed in the context. For this example, we'll keep them hardcoded.
	const Position = 1
	const Velocity = 2
	
	// Direct data access is more performant and data-oriented than chunk.getComponent().
	const positions = chunk.componentData[Position]
	const velocities = chunk.componentData[Velocity]

	for (let i = 0; i < chunk.size; i++) {
		positions.x[i] += velocities.x[i] * speed * deltaTime
		positions.y[i] += velocities.y[i] * speed * deltaTime
	}
	// The system is responsible for marking components as dirty.
	// chunk.markAllDirty(Position, frameContext.currentTick);
}

/**
 * A custom "listener" kernel that processes dynamic requests from a shared buffer.
 */
export function processBoostRequests(systemContext) {
	const { boostRequestQueue } = systemContext
	// 'frameContext' is available in the worker's global scope.
	const { currentTick } = frameContext

	// The helper class abstracts away the Atomics and SAB manipulation.
	let request
	while ((request = boostRequestQueue.claimRequest())) {
		const { entityId, boostAmount } = request

		// This is a simplified example. A real implementation would need a way
		// to get a writable view of a single entity's component data on a worker.
		// For this demonstration, we'll log that we received the request.
		console.log(`%c[Kernel/Worker] Received boost request for entity ${entityId}.`, 'color: cyan')
	}
}