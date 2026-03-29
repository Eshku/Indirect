const { engine } = await import(`@client/Engine.js`)
const { ecs, gameManager } = engine.getManagers()

// Define a single, simple visual style for the cursor.
const CURSOR_VISUALS = {
	size: 5,
	width: 2,
	color: 0x2080ff, // Standard blue
}

/**
 * A system dedicated to creating, managing, and updating the cursor.
 * It controls the cursor's position and visual state.
 * - It hooks into the renderer's 'prerender' event to update its position with low latency.
 * - It runs in the main update loop to update the cursor entity's world position.
 */

const { position, cursorTag, playerTag } = ecs.getTypeIDs()

export class CursorSystem {
	/**
	 * Initializes the system. This is called by the SystemManager once.
	 */
	async init() {
		// --- Component/Entity State ---
		this.cursorQuery = this.getQuery({ with: [cursorTag] })

		this.playerQuery = this.getQuery({ with: [playerTag, position] })

		// Position
		this.hardwarePosition = { x: 0, y: 0 }

		const { layerManager, gameManager } = engine.getManagers()

		this.pixiApp = gameManager.getApp()
		this.renderer = this.pixiApp.renderer
		this.cursorLayer = layerManager.getLayer('cursor')

		if (!this.pixiApp || !this.cursorLayer) {
			throw new Error('CursorSystem: PIXI.Application instance and cursor layer are required.')
		}

		// Create a single graphics object for the cursor
		this.cursorGraphic = new PIXI.Graphics()
		this.cursorLayer.addChild(this.cursorGraphic)

		// Find the cursor entity that was instantiated from the prefab
		for (const chunk of this.cursorQuery.iter()) {
			this.cursorEntityId = chunk.entities[0]
		}

		if (this.cursorEntityId === null) {
			console.error('CursorSystem: Could not find the cursor entity. Was it instantiated at startup?')
			return // Stop initialization if the entity isn't found
		}

		this.playerId = this.playerQuery.getSingleEntity()
		if (!this.playerId) {
			console.error('CursorSystem: Could not find player entity for camera reference.')
		}

		// Snap initial positions to the current hardware cursor position
		const pointer = this.renderer.events.pointer
		this.hardwarePosition.x = pointer.global.x
		this.hardwarePosition.y = pointer.global.y

		// Set initial state and show
		this._drawCursor()
		this._setScreenPosition(this.hardwarePosition.x, this.hardwarePosition.y)
		this._show()
	}

	/**
	 * Runs every frame to update the cursor's screen position and its corresponding
	 * world position in the cursor entity.
	 * @param {object} context - The frame context object.
	 */
	update({ deltaTime, currentTick }) {
		// Update hardware position from input
		const pointer = this.renderer.events.pointer
		this.hardwarePosition.x = pointer.global.x
		this.hardwarePosition.y = pointer.global.y

		const screenWidth = gameManager.getApp().screen.width
		const screenHeight = gameManager.getApp().screen.height

		// Always update the graphic's screen position to match hardware.
		this.updatePosition()

		let playerX = 0
		let playerY = 0

		// Get player position. This is a singleton query.
		for (const chunk of this.playerQuery.iter()) {
			playerX = chunk.componentData[position].x[0]
			playerY = chunk.componentData[position].y[0]
		}

		// This is a singleton query, so it will only run once.
		for (const chunk of this.cursorQuery.iter()) {
			// Convert screen-space hardware position to world-space coordinates.
			// This accounts for camera panning by using the player's position as the camera's focus.
			const worldX = this.hardwarePosition.x + playerX - screenWidth / 2
			const worldY = -this.hardwarePosition.y + playerY + screenHeight / 2

			const positions = chunk.componentData[position]
			positions.x[0] = worldX
			positions.y[0] = worldY
		}
	}

	/**
	 * Updates the position of the cursor graphic.
	 * @private
	 */
	updatePosition() {
		// Set the cursor graphic's position to the hardware position.
		this._setScreenPosition(this.hardwarePosition.x, this.hardwarePosition.y)
	}

	/**
	 * Sets the position of the cursor on the screen.
	 * @param {number} x - The x-coordinate.
	 * @param {number} y - The y-coordinate.
	 * @private
	 */
	_setScreenPosition(x, y) {
		this.cursorGraphic.position.set(x, y)
	}

	/**
	 * Draws the cursor graphic based on the current visual properties.
	 * @private
	 */
	_drawCursor() {
		this.cursorGraphic.clear()
		this.cursorGraphic.circle(0, 0, CURSOR_VISUALS.size).stroke({
			width: CURSOR_VISUALS.width,
			color: CURSOR_VISUALS.color,
		})
	}

	/**
	 * Shows the cursor.
	 * @private
	 */
	_show() {
		this.cursorGraphic.visible = true
	}

	/**
	 * Hides the cursor.
	 * @private
	 */
	_hide() {
		this.cursorGraphic.visible = false
	}

	destroy() {
		if (this.cursorLayer) {
			this.cursorLayer.removeChild(this.cursorGraphic)
		}

		this.cursorGraphic?.destroy()
		this.cursorGraphic = null
		this.cursorLayer = null
		this.pixiApp = null
		this.renderer = null
	}
}
