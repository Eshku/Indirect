const { engine } = await import(`@client/Engine.js`)
const { ecs, physicsManager } = engine.getManagers()
const { eventEmitter } = await import(`@core/Classes/EventEmitter.js`)
const { SpatialHashGrid } = await import(`@core/DataStructures/SpatialHashGrid.js`)

const { cursorTag, position } = ecs.getComponentIDs()

/**
 * An in-game debugging tool that allows inspecting an entity's component data
 * by clicking on it while holding a modifier key.
 */
export class DebugInspectionSystem {
	static dependencies = {
		// No ECS data dependencies, this is purely event-driven.
	}

	init() {
		// Get access to the spatial hash grid for finding entities at a point.
		const gridSABs = physicsManager.getSpatialHashGridSABs()
		this.grid = new SpatialHashGrid(gridSABs)

		// Query for the cursor to get its world position.
		this.cursorQuery = this.getQuery({ with: [cursorTag, position] })

		// A reusable query result object to avoid allocations.
		this.queryResult = {
			count: 0,
			capacity: 16, // We only need to find one or a few entities.
			entityIds: new BigUint64Array(16),
			chunkIds: new Uint16Array(16),
			entityIndices: new Uint16Array(16),
		}

		// Listen for the inspection input event.
		eventEmitter.on('Input InspectEntity', this.inspectAtCursor)
	}

	// Use an arrow function to automatically bind `this`.
	inspectAtCursor = event => {
		// Only inspect on key down/press.
		if (!event.isActive) return

		const cursorChunk = this.cursorQuery.getSingleChunk()
		if (!cursorChunk) return

		const cursorX = cursorChunk.componentData[position].x[0]
		const cursorY = cursorChunk.componentData[position].y[0]

		this.grid.queryRadius(cursorX, cursorY, 5, this.queryResult)

		console.log(`--- Inspecting ${this.queryResult.count} entities at (${cursorX.toFixed(2)}, ${cursorY.toFixed(2)}) ---`)
		for (let i = 0; i < this.queryResult.count; i++) {
			console.log(ecs.viewEntity(this.queryResult.entityIds[i]))
		}
		console.log('--- End Inspection ---')
	}

	destroy() {
		// Clean up the event listener on HMR or shutdown.
		eventEmitter.off('Input InspectEntity', this.inspectAtCursor)
	}
}