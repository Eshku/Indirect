const { SpatialHashGrid, SPATIAL_GRID_CONFIG, NODE_BYTE_STRIDE } = await import(
	`${PATH_CORE}/DataStructures/SpatialHashGrid.js`
)

/**
 * Manages global physics-related data and configurations.
 * This manager is the owner of shared data structures used by physics systems,
 * such as the SharedArrayBuffers for the SpatialHashGrid.
 */
export class PhysicsManager {
	constructor() {
		/**
		 * @property {object | null} spatialHashGridSABs - The SharedArrayBuffers for the spatial grid.
		 */
		this.spatialHashGridSABs = null
	}

	/**
	 * Initializes the PhysicsManager. This is where shared resources are created.
	 */
	init() {
		// Create the shared buffers for the spatial hash grid.
		// The manager now owns these buffers.
		this.spatialHashGridSABs = this._createSpatialGridSABs(SPATIAL_GRID_CONFIG)
	}

	/**
	 * @returns {object | null} The object containing the SharedArrayBuffers for the spatial hash grid.
	 */
	getSpatialHashGridSABs() {
		return this.spatialHashGridSABs
	}

	/**
	 * Creates and initializes all the necessary SharedArrayBuffers for the grid.
	 * @param {object} config - The configuration object for the grid.
	 * @returns {object} An object containing all the created SharedArrayBuffers.
	 * @private
	 */
	_createSpatialGridSABs(config) {
		const gridCellsSAB = new SharedArrayBuffer(config.GRID_WIDTH * config.GRID_HEIGHT * Int32Array.BYTES_PER_ELEMENT)
		const gridOriginSAB = new SharedArrayBuffer(2 * Float64Array.BYTES_PER_ELEMENT) // [originX, originY]
		const nodesSAB = new SharedArrayBuffer(config.MAX_NODES * NODE_BYTE_STRIDE)
		const allocatorSAB = new SharedArrayBuffer(Uint32Array.BYTES_PER_ELEMENT) // [nextNodeIndex]

		// Initialize the grid cells to -1 (empty)
		new Int32Array(gridCellsSAB).fill(-1)

		return {
			gridCellsSAB,
			gridOriginSAB,
			nodesSAB,
			allocatorSAB,
			config,
		}
	}

	destroy() {
		this.spatialHashGridSABs = null
	}
}

export const physicsManager = new PhysicsManager()