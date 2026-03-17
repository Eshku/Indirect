const { SpatialHashGrid, SPATIAL_GRID_CONFIG, NODE_BYTE_STRIDE } = await import(
	`@core/DataStructures/SpatialHashGrid.js`
)

const MAX_PHYSICS_LAYERS = 32 // We can have up to 32 distinct layers.

/**
 * Defines the physics layers for collision detection. Each layer is a bit in a bitmask.
 * This object is frozen to ensure immutability and is exported for use in authoring
 * prefabs and for debugging.
 * @example
 * // To get the group for a player:
 * import { PhysicsLayers } from '@managers/PhysicsManager/PhysicsManager.js';
 * const playerGroup = PhysicsLayers.PLAYER; // 1
 */

export const PhysicsLayers = Object.freeze({
	NONE: 0,
	PLAYER: 1 << 0, // 1
	ENEMY: 1 << 1, // 2
	PLAYER_PROJECTILE: 1 << 2, // 4
	PICKUP: 1 << 3, // 8
})

/**
 * Defines the collision interaction matrix. For a given layer (the key), the value is a bitmask
 * of all layers it can collide with. This serves as the single source of truth for collision rules
 * when authoring prefabs.
 */

export const LayerMasks = Object.freeze({
	[PhysicsLayers.NONE]: PhysicsLayers.NONE,
	[PhysicsLayers.PLAYER]: PhysicsLayers.ENEMY | PhysicsLayers.PICKUP,
	[PhysicsLayers.ENEMY]: PhysicsLayers.PLAYER | PhysicsLayers.ENEMY | PhysicsLayers.PLAYER_PROJECTILE,
	[PhysicsLayers.PLAYER_PROJECTILE]: PhysicsLayers.ENEMY,
	[PhysicsLayers.PICKUP]: PhysicsLayers.PLAYER,
})

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
		/**
		 * @property {SharedArrayBuffer | null} collisionMatrixSAB - A SAB holding the global collision rules.
		 */
		this.collisionMatrixSAB = null
	}

	/**
	 * Initializes the PhysicsManager. This is where shared resources are created.
	 */
	init() {
		// 1. Create the shared buffers for the spatial hash grid.
		this.spatialHashGridSABs = this._createSpatialGridSABs(SPATIAL_GRID_CONFIG)

		// 2. Create and compile the global collision matrix.
		this.collisionMatrixSAB = new SharedArrayBuffer(MAX_PHYSICS_LAYERS * Uint32Array.BYTES_PER_ELEMENT)
		const collisionMatrixView = new Uint32Array(this.collisionMatrixSAB)

		// Populate the matrix from our human-readable LayerMasks object.
		for (const group in LayerMasks) {
			// The 'group' is a string key, but it represents the numeric group value.
			const groupIndex = Number(group)
			if (groupIndex < MAX_PHYSICS_LAYERS) {
				collisionMatrixView[groupIndex] = LayerMasks[group]
			}
		}
	}

	/**
	 * @returns {object | null} The object containing the SharedArrayBuffers for the spatial hash grid.
	 */
	getSpatialHashGridSABs() {
		return this.spatialHashGridSABs
	}

	/**
	 * @returns {SharedArrayBuffer | null} The SharedArrayBuffer for the global collision matrix.
	 */
	getCollisionMatrixSAB() {
		return this.collisionMatrixSAB
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
		this.collisionMatrixSAB = null
	}
}

export const physicsManager = new PhysicsManager()
