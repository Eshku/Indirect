// --- Constants ---
// These can be tuned based on game needs.
export const SPATIAL_GRID_CONFIG = {
	GRID_WIDTH: 256, // In cells
	GRID_HEIGHT: 256, // In cells
	CELL_SIZE: 32, // In world units (e.g., pixels)
	MAX_NODES: 65536 * 2, // Max entities that can be in the grid at once (including duplicates for large entities)
	// Hysteresis: How far (in cells) the player can move from the center before the grid "snaps"
	SAFE_ZONE_OFFSET: 64,
}

// --- Node Layout (16 bytes per node) ---
export const NODE_BYTE_STRIDE = 16
// BigUint64Array views the buffer in 8-byte chunks. A 16-byte node is 2 chunks.
export const NODE_ENTITY_ID_STRIDE_IN_U64 = 2
// Int32Array views the buffer in 4-byte chunks. A 16-byte node is 4 chunks.
export const NODE_NEXT_INDEX_STRIDE_IN_I32 = 4
// The nextIndex is at byte 8, which is the 2nd element in an Int32Array view of the node.
export const NODE_NEXT_INDEX_OFFSET_IN_I32 = 2

/**
 * A thread-safe, sliding spatial hash grid built on SharedArrayBuffers.
 * This class provides an API to interact with the shared data structures, but does not hold state itself.
 * It's designed to be instantiated on both the main thread and worker threads.
 */
export class SpatialHashGrid {
	/**
	 * @param {object} sharedBuffers - The object containing the SABs from initSABs.
	 */
	constructor({ gridCellsSAB, gridOriginSAB, nodesSAB, allocatorSAB, config }) {
		this.config = config

		// --- Create TypedArray views over the shared buffers ---
		this.gridCellsView = new Int32Array(gridCellsSAB)
		this.gridOriginView = new Float64Array(gridOriginSAB)
		this.nodeEntityIdView = new BigUint64Array(nodesSAB)
		this.nodeNextIndexView = new Int32Array(nodesSAB)
		this.allocatorView = new Uint32Array(allocatorSAB)

		// --- Pre-calculate constants for convenience ---
		this.gridWidth = this.config.GRID_WIDTH
		this.gridHeight = this.config.GRID_HEIGHT
		this.cellSize = this.config.CELL_SIZE
		this.maxNodes = this.config.MAX_NODES
		this.invCellSize = 1 / this.config.CELL_SIZE
		this.safeZoneOffset = this.config.SAFE_ZONE_OFFSET
	}

	// =======================================================================
	// Main Thread Methods (Writer)
	// =======================================================================

	/**
	 * Clears the grid and repositions it based on the player's position using hysteresis.
	 * This should be called once per frame on the main thread before populating.
	 * @param {number} playerX - The player's world X coordinate.
	 * @param {number} playerY - The player's world Y coordinate.
	 */
	clearAndReposition(playerX, playerY) {
		const [originX, originY] = this.gridOriginView
		const gridHalfWidth = (this.gridWidth / 2) * this.cellSize
		const gridHalfHeight = (this.gridHeight / 2) * this.cellSize
		const safeZoneHalfSize = this.safeZoneOffset * this.cellSize

		// Calculate the current safe zone boundaries
		const safeZoneCenterX = originX + gridHalfWidth
		const safeZoneCenterY = originY + gridHalfHeight
		const safeMinX = safeZoneCenterX - safeZoneHalfSize
		const safeMaxX = safeZoneCenterX + safeZoneHalfSize
		const safeMinY = safeZoneCenterY - safeZoneHalfSize
		const safeMaxY = safeZoneCenterY + safeZoneHalfSize

		// Check if the player has moved outside the safe zone
		if (playerX < safeMinX || playerX > safeMaxX || playerY < safeMinY || playerY > safeMaxY) {
			// Snap the grid to re-center on the player's new position
			this.gridOriginView[0] = playerX - gridHalfWidth
			this.gridOriginView[1] = playerY - gridHalfHeight
		}

		// Reset the grid for the new frame
		this.gridCellsView.fill(-1)
		this.allocatorView[0] = 0
	}

	/**
	 * Populates the grid with an entity.
	 * @param {bigint} entityId - The ID of the entity.
	 * @param {number} minX - The minimum world X coordinate of the entity's AABB.
	 * @param {number} minY - The minimum world Y coordinate of the entity's AABB.
	 * @param {number} maxX - The maximum world X coordinate of the entity's AABB.
	 * @param {number} maxY - The maximum world Y coordinate of the entity's AABB.
	 * @returns {boolean} - True if the entity was added, false if it was out of bounds or the grid was full.
	 */
	add(entityId, minX, minY, maxX, maxY) {
		const [originX, originY] = this.gridOriginView
		const gridWorldWidth = this.gridWidth * this.cellSize
		const gridWorldHeight = this.gridHeight * this.cellSize

		// Broad-phase culling: if the entity is entirely outside the grid's world bounds, do nothing.
		// This prevents entities far away from being incorrectly added to the grid's edge cells.
		if (maxX < originX || minX > originX + gridWorldWidth || maxY < originY || minY > originY + gridWorldHeight) {
			return false // Not added, but not an error. It's just culled.
		}

		// Convert world coordinates to grid cell coordinates
		const startX = Math.floor((minX - originX) * this.invCellSize)
		const startY = Math.floor((minY - originY) * this.invCellSize)
		// The AABB is treated as a half-open interval [min, max). To handle cases where the
		// max coordinate falls exactly on a cell boundary, we subtract a small epsilon.
		// This ensures that an entity with AABB [0, 32) is correctly placed only in cell 0, not cell 1.
		const endX = Math.floor((maxX - 1e-9 - originX) * this.invCellSize)
		const endY = Math.floor((maxY - 1e-9 - originY) * this.invCellSize)

		// Clamp to grid bounds
		const clampedStartX = Math.max(0, startX)
		const clampedStartY = Math.max(0, startY)
		const clampedEndX = Math.min(this.gridWidth - 1, endX)
		const clampedEndY = Math.min(this.gridHeight - 1, endY)

		let added = false
		for (let y = clampedStartY; y <= clampedEndY; y++) {
			for (let x = clampedStartX; x <= clampedEndX; x++) {
				const cellIndex = y * this.gridWidth + x
				if (this._addNode(cellIndex, entityId)) {
					added = true
				} else {
					// Grid is full, stop trying to add.
					return added
				}
			}
		}
		return added
	}

	/**
	 * Internal helper to add a node to a cell's linked list.
	 * @private
	 */
	_addNode(cellIndex, entityId) {
		const nodeIndex = this.allocatorView[0]

		// Overflow check
		if (nodeIndex >= this.maxNodes) {
			console.warn(`SpatialHashGrid ran out of nodes. Max: ${this.maxNodes}. Some entities were not added.`)
			return false
		}

		this.allocatorView[0]++

		// Get the current head of the linked list for this cell
		const headIndex = this.gridCellsView[cellIndex]

		// Write the new node's data
		this.nodeEntityIdView[nodeIndex * NODE_ENTITY_ID_STRIDE_IN_U64] = entityId
		this.nodeNextIndexView[nodeIndex * NODE_NEXT_INDEX_STRIDE_IN_I32 + NODE_NEXT_INDEX_OFFSET_IN_I32] = headIndex

		// Prepend the new node by updating the cell's head pointer
		this.gridCellsView[cellIndex] = nodeIndex

		return true
	}

	// =======================================================================
	// Worker/Main Thread Methods (Reader)
	// =======================================================================

	/**
	 * Queries the grid for entities within a given rectangular area.
	 * @param {number} minX - The minimum world X coordinate of the query box.
	 * @param {number} minY - The minimum world Y coordinate of the query box.
	 * @param {number} maxX - The maximum world X coordinate of the query box.
	 * @param {number} maxY - The maximum world Y coordinate of the query box.
	 * @param {Set<bigint>} resultSet - A Set to which the unique entity IDs will be added.
	 */
	queryBox(minX, minY, maxX, maxY, resultSet) {
		const [originX, originY] = this.gridOriginView

		// Convert world coordinates to grid cell coordinates
		const startX = Math.floor((minX - originX) * this.invCellSize)
		const startY = Math.floor((minY - originY) * this.invCellSize)
		// The AABB is a half-open interval [min, max), so the end coordinate should not be included
		// if it lies exactly on a boundary. Subtracting a small epsilon handles this robustly.
		const endX = Math.floor((maxX - 1e-9 - originX) * this.invCellSize)
		const endY = Math.floor((maxY - 1e-9 - originY) * this.invCellSize)

		// Clamp to grid bounds
		const clampedStartX = Math.max(0, startX)
		const clampedStartY = Math.max(0, startY)
		const clampedEndX = Math.min(this.gridWidth - 1, endX)
		const clampedEndY = Math.min(this.gridHeight - 1, endY)

		for (let y = clampedStartY; y <= clampedEndY; y++) {
			for (let x = clampedStartX; x <= clampedEndX; x++) {
				const cellIndex = y * this.gridWidth + x
				this._traverseCell(cellIndex, resultSet)
			}
		}
	}

	/**
	 * Queries the grid for entities within a given radius.
	 * This performs a broad-phase query using the circle's bounding box.
	 * @param {number} x - The world X coordinate of the circle's center.
	 * @param {number} y - The world Y coordinate of the circle's center.
	 * @param {number} radius - The radius of the circle.
	 * @param {Set<bigint>} resultSet - A Set to which the unique entity IDs will be added.
	 */
	queryRadius(x, y, radius, resultSet) {
		this.queryBox(x - radius, y - radius, x + radius, y + radius, resultSet)
	}

	/**
	 * Traverses the linked list for a given cell and adds all entity IDs to the result set.
	 * @private
	 */
	_traverseCell(cellIndex, resultSet) {
		let nodeIndex = this.gridCellsView[cellIndex]

		while (nodeIndex !== -1) {
			const entityId = this.nodeEntityIdView[nodeIndex * NODE_ENTITY_ID_STRIDE_IN_U64]
			resultSet.add(entityId)

			nodeIndex = this.nodeNextIndexView[nodeIndex * NODE_NEXT_INDEX_STRIDE_IN_I32 + NODE_NEXT_INDEX_OFFSET_IN_I32]
		}
	}
}
