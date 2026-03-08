const { engine } = await import(`@client/Engine.js`)
const { ecs, layerManager, physicsManager } = engine.getManagers()
const {
	SpatialHashGrid,
	SPATIAL_GRID_CONFIG,
	NODE_NEXT_INDEX_STRIDE_IN_I32,
	NODE_NEXT_INDEX_OFFSET_IN_I32,
	NODE_ENTITY_ID_STRIDE_IN_U64,
} = await import(`@core/DataStructures/SpatialHashGrid.js`)

/**
 * A debug system to visualize the state of the SpatialHashGrid in real-time.
 * It draws the grid lines and represents each entity within a cell as a small colored square.
 * This is a powerful tool for verifying that entities are being correctly added to the grid.
 */
export class SpatialHashDebugSystem {
	init() {
		this.graphics = new PIXI.Graphics()
		// Get a read-only API instance for the grid, using the same shared buffers.
		this.grid = new SpatialHashGrid(physicsManager.getSpatialHashGridSABs())

		// Add the graphics to the main game container so it inherits camera transforms (like Y-axis inversion).
		const gameLayer = layerManager.getLayer('gameContainer')
		if (gameLayer) {
			gameLayer.addChild(this.graphics)
		} else {
			console.error('[SpatialHashDebugSystem] Could not find "gameContainer" layer.')
		}
	}

	update() {
		// Clear any drawings from the previous frame.
		this.graphics.clear()

		const [originX, originY] = this.grid.gridOriginView
		const { gridWidth, gridHeight, cellSize, nodeNextIndexView, nodeEntityIdView } = this.grid

		// --- 1. Draw Grid Lines ---
		this.graphics.lineStyle(1, 0x444444, 0.4) // Thin, dark grey lines

		for (let y = 0; y <= gridHeight; y++) {
			const worldY = originY + y * cellSize
			this.graphics.moveTo(originX, -worldY)
			this.graphics.lineTo(originX + gridWidth * cellSize, -worldY)
		}
		for (let x = 0; x <= gridWidth; x++) {
			const worldX = originX + x * cellSize
			this.graphics.moveTo(worldX, -originY)
			this.graphics.lineTo(worldX, -(originY + gridHeight * cellSize))
		}

		// --- 2. Draw Cell Contents ---
		for (let y = 0; y < gridHeight; y++) {
			for (let x = 0; x < gridWidth; x++) {
				const cellIndex = y * gridWidth + x
				const headNodeIndex = this.grid.gridCellsView[cellIndex]

				// If the cell is not empty, draw a highlight over it.
				if (headNodeIndex !== -1) {
					const cellWorldX = originX + x * cellSize
					const cellWorldY = originY + y * cellSize

					// For simplicity, we'll color the cell based on the first entity found.
					const firstEntityId = nodeEntityIdView[headNodeIndex * NODE_ENTITY_ID_STRIDE_IN_U64]

					let color
					if (ecs.hasComponent(firstEntityId, 'playerTag')) {
						color = 0x00ff00 // Green for player
					} else {
						color = 0xff0000 // Red for enemies
					}

					// Draw a semi-transparent rectangle covering the entire cell.
					// The Y coordinate is inverted to match the game's coordinate system.
					// The rect's Y is its top edge, so we must offset by the cell height.
					this.graphics.beginFill(color, 0.3)
					this.graphics.drawRect(cellWorldX, -(cellWorldY + cellSize), cellSize, cellSize)
					this.graphics.endFill()
				}
			}
		}
	}

	destroy() {
		if (this.graphics) {
			this.graphics.destroy()
			this.graphics = null
		}
	}
}
