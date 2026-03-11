const { Cursor } = await import(`@ui/Cursor.js`)
const { lerp } = await import(`@core/utils/lerp.js`)
const { Easing } = await import(`@core/utils/easing.js`)
const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const { lerpColor, getCatmullRomPoint } = await import(`@core/utils/lerp.js`)
const { CursorState: CursorStateDef } = await import(`@client/Components/UI/CursorState.js`)

const DEFAULT_STATES = {
	// Default "aiming" state when over empty ground.
	default: {
		size: 10,
		trailDuration: 0.15, // in seconds
		trailColor: 0x2080ff, // Standard blue
		coreGradient: [
			{ offset: 0, color: 'rgba(255, 255, 255, 1)' },
			{ offset: 0.5, color: 'rgba(32, 128, 255, 1)' },
			{ offset: 1, color: 'rgba(32, 128, 255, 0)' },
		],
	},
	// "Neutral" state for non-interactive UI or scenery.
	neutral: {
		size: 10,
		trailDuration: 0.1,
		trailColor: 0xa0c0ff, // Lighter, softer blue
		coreGradient: [
			{ offset: 0, color: 'rgba(255, 255, 255, 1)' },
			{ offset: 0.5, color: 'rgba(160, 192, 255, 1)' }, // Lighter blue
			{ offset: 1, color: 'rgba(160, 192, 255, 0)' },
		],
	},
	// State for interactable elements like UI buttons or loot.
	interactable: {
		size: 12, // Slightly larger to draw attention
		trailDuration: 0.1,
		trailColor: 0x00ff00, // Green for "go" or "interact"
		coreGradient: [
			{ offset: 0, color: 'rgba(255, 255, 255, 1)' },
			{ offset: 0.5, color: 'rgba(0, 255, 0, 1)' }, // Green
			{ offset: 1, color: 'rgba(0, 255, 0, 0)' },
		],
	},
	// State for hostile entities.
	enemy: {
		size: 12, // Slightly larger to indicate target
		trailDuration: 0.08, // Shorter, more aggressive trail
		trailColor: 0xff0000, // Red for "danger" or "attack"
		coreGradient: [
			{ offset: 0, color: 'rgba(255, 255, 255, 1)' },
			{ offset: 0.5, color: 'rgba(255, 0, 0, 1)' }, // Red
			{ offset: 1, color: 'rgba(255, 0, 0, 0)' },
		],
	},
	// Placeholder state for friendly or neutral NPCs/players.
	friendly: {
		size: 11,
		trailDuration: 0.12,
		trailColor: 0x00ffff, // Cyan for "friendly"
		coreGradient: [
			{ offset: 0, color: 'rgba(255, 255, 255, 1)' },
			{ offset: 0.5, color: 'rgba(0, 255, 255, 1)' }, // Cyan
			{ offset: 1, color: 'rgba(0, 255, 255, 0)' },
		],
	},
	// Placeholder state for when an action is invalid (e.g., on an invalid target).
	invalidAction: {
		size: 12,
		trailDuration: 0.1,
		trailColor: 0x808080, // Grey for "disabled" or "invalid"
		coreGradient: [
			{ offset: 0, color: 'rgba(180, 180, 180, 1)' },
			{ offset: 0.5, color: 'rgba(128, 128, 128, 1)' }, // Grey
			{ offset: 1, color: 'rgba(128, 128, 128, 0)' },
		],
	},
}

const TRANSITION_DURATION = 0.25 // seconds

/**
 * A system dedicated to creating, managing, and updating the cursor.
 * It controls the cursor's position, visual state, and special effects
 * like trails.
 * - It hooks into the renderer's 'prerender' event to update its position with low latency.
 * - It runs in the main update loop to check for interactions with UI elements and change state accordingly.
 */

const { position, cursorTag, cursorState, playerTag } = ecs.getTypeIDs()
export class CursorSystem {
	/**
	 * Initializes the system. This is called by the SystemManager once.
	 */
	async init() {
		// --- Component/Entity State ---

		this.cursorStateComponent = cursorState
		this.cursorQuery = this.getQuery({ with: [cursorTag] })
		this.cursorEntityId = null
		this.positionPayload = null
		this.cursorStatePayload = null
		this.playerQuery = this.getQuery({ with: [playerTag, position] })
		this.playerId = null

		// --- Visual State Management ---
		this.states = DEFAULT_STATES
		this.cursorStateFlags = CursorStateDef.flags.of
		this.sourceStateName = 'default'
		this.targetStateName = 'default'
		this.transition = {
			progress: 1.0,
		}
		this.currentVisuals = { ...this.states.default } // Holds interpolated visual values
		this.stateTextures = {} // Cache for generated textures

		// Effects management
		this.trailPoints = []
		this.trailPointPool = [] // Object pool for trail points to reduce GC pressure

		// Smoothing
		this.hardwarePosition = { x: 0, y: 0 }
		this.visualPosition = { x: 0, y: 0 }
		this.lerpSpeed = 25 // Higher is more responsive, lower is smoother.

		// Optimization properties
		this.previousHardwarePosition = { x: -1, y: -1 }
		this.isSettled = false
		this.lastTrailPoint = { x: -1, y: -1 }
		this.minTrailPointDistanceSq = 4 // pixels squared (2*2)

		const { layerManager, gameManager } = engine.getManagers()

		this.pixiApp = gameManager.getApp()
		this.renderer = this.pixiApp.renderer
		const cursorLayer = layerManager.getLayer('cursor')

		// Create the visual cursor component
		this.cursor = new Cursor(this.pixiApp, cursorLayer)

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

		// Pre-compile payloads for updating components. This is a one-time setup.
		this.positionPayload = this.compile(position, { x: 0, y: 0 })
		this.cursorStatePayload = this.compile(this.cursorStateComponent, { flags: 0 })

		// Pre-generate all state textures
		await this._generateAllStateTextures()

		// Snap initial positions to the current hardware cursor position
		const pointer = this.renderer.events.pointer
		this.hardwarePosition.x = pointer.global.x
		this.hardwarePosition.y = pointer.global.y
		this.visualPosition.x = this.hardwarePosition.x
		this.visualPosition.y = this.hardwarePosition.y

		// Set initial state and show
		this.currentVisuals = { ...this.states[this.targetStateName] }
		this.cursor.setCoreTexture(this.stateTextures[this.targetStateName].core)
		this.cursor.updateVisuals(this.currentVisuals, 1.0)
		this.cursor.setScreenPosition(this.visualPosition.x, this.visualPosition.y)
		this.cursor.show()
	}

	/**
	 * Runs every frame to check for interactions with UI elements and update the cursor state.
	 * @param {object} context - The frame context object.
	 */
	update({ deltaTime }) {
		// 1. Update hardware position from input
		const pointer = this.renderer.events.pointer
		this.hardwarePosition.x = pointer.global.x
		this.hardwarePosition.y = pointer.global.y

		const positionChanged =
			this.hardwarePosition.x !== this.previousHardwarePosition.x ||
			this.hardwarePosition.y !== this.previousHardwarePosition.y

		// Update previous position for the next frame's check
		this.previousHardwarePosition.x = this.hardwarePosition.x
		this.previousHardwarePosition.y = this.hardwarePosition.y

		// Determine if the visual cursor has caught up to the hardware cursor
		const dx = this.hardwarePosition.x - this.visualPosition.x
		const dy = this.hardwarePosition.y - this.visualPosition.y
		this.isSettled = Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1

		// 2. Update visual state and position only if the cursor has moved or is transitioning.
		if (positionChanged || !this.isSettled || this.transition.progress < 1.0) {
			if (positionChanged) {
				this.updateState()
			}
			this.updatePosition(deltaTime)
			this.updateTransition(deltaTime)
		}

		// 3. ALWAYS update the world position of the cursor entity.
		// This is the critical fix: this block now runs every frame, ensuring the
		// cursor's world coordinates are correct even when the player moves and the mouse is still.
		if (this.cursorEntityId !== null) {
			const playerPosition = this.getComponent(this.playerId, position)
			const { gameManager } = engine.getManagers()
			const screenWidth = gameManager.getApp().screen.width
			const screenHeight = gameManager.getApp().screen.height

			let worldX = this.visualPosition.x
			let worldY = this.visualPosition.y

			if (playerPosition) {
				// Convert screen-space visual position to world-space coordinates.
				// This accounts for camera panning by using the player's position as the camera's focus.
				worldX = this.visualPosition.x + playerPosition.x - screenWidth / 2
				worldY = -this.visualPosition.y + playerPosition.y + screenHeight / 2
			}

			// Update position component
			const posMutators = this.positionPayload.mutators.position
			posMutators.x[0] = worldX
			posMutators.y[0] = worldY
			this.setComponentData(this.cursorEntityId, this.positionPayload.payload)

			// Update state component
			const stateFlag = this.cursorStateFlags[this.targetStateName.toUpperCase()] || this.cursorStateFlags.DEFAULT
			this.cursorStatePayload.mutators.cursorState.flags[0] = stateFlag
			this.setComponentData(this.cursorEntityId, this.cursorStatePayload.payload)
		}

		// 4. ALWAYS update the trail effect.
		this.updateTrail(this.visualPosition)
	}

	/**
	 * Changes the active state of the cursor and updates its visuals.
	 * @param {string} stateName - The name of the state to activate.
	 */
	setState(stateName) {
		if (stateName === this.targetStateName || !this.states[stateName]) {
			return
		}

		// If a transition is in progress, start the new one from the current interpolated state.
		if (this.transition.progress < 1.0) {
			this._updateInterpolatedVisuals()
			// Create a temporary state config to transition from by creating a snapshot of the current visuals.
			this.states._current = { ...this.currentVisuals }
			this.sourceStateName = '_current'
		} else {
			this.sourceStateName = this.targetStateName
		}

		this.targetStateName = stateName
		this.transition.progress = 0

		// Tell the Cursor view to prepare for a texture transition
		const newTexture = this.stateTextures[this.targetStateName].core
		this.cursor.startCoreTransition(newTexture)
	}

	/**
	 * Determines the correct cursor state based on what the hardware cursor is hovering over.
	 * @private
	 */
	updateState() {
		const { uiManager } = engine.getManagers()
		// TODO: Implement entity hover detection
		const hoveredEntity = null // Placeholder for now
		const hoveredElement = uiManager.getHoveredElement(this.hardwarePosition)

		// Determine the new state based on a priority system
		let newStateName = 'default'
		if (hoveredEntity && hoveredEntity.team === 'enemy') {
			// This is a placeholder for future logic
			newStateName = 'enemy'
		} else if (hoveredElement) {
			// Assuming UI elements have an 'isInteractable' property
			newStateName = hoveredElement.isInteractable ? 'interactable' : 'neutral'
		}

		if (newStateName !== this.targetStateName) {
			this.setState(newStateName)
		}
	}

	/**
	 * Updates the smoothed visual position of the cursor sprite.
	 * @param {number} deltaTime - The time elapsed since the last frame.
	 * @private
	 */
	updatePosition(deltaTime) {
		if (this.isSettled) {
			// Snap to the final position to avoid infinitesimal lerping.

			this.visualPosition.x = this.hardwarePosition.x
			this.visualPosition.y = this.hardwarePosition.y
		} else {
			// A frame-rate independent lerp formula is used for consistent smoothing.
			const lerpFactor = 1 - Math.exp(-this.lerpSpeed * deltaTime)
			this.visualPosition.x = lerp(this.visualPosition.x, this.hardwarePosition.x, lerpFactor)
			this.visualPosition.y = lerp(this.visualPosition.y, this.hardwarePosition.y, lerpFactor)
		}

		// Set the cursor sprite's position to the smoothed visual position.
		this.cursor.setScreenPosition(this.visualPosition.x, this.visualPosition.y)
	}

	/**
	 * Calculates the current visual properties by interpolating between states.
	 * @private
	 */
	_updateInterpolatedVisuals() {
		const fromConfig = this.states[this.sourceStateName]
		const toConfig = this.states[this.targetStateName]

		if (!fromConfig || !toConfig) {
			this.currentVisuals = { ...this.states[this.targetStateName] }
			return
		}

		const progress = Easing.easeOutCubic(this.transition.progress)

		this.currentVisuals.size = lerp(fromConfig.size, toConfig.size, progress)
		this.currentVisuals.trailDuration = lerp(fromConfig.trailDuration, toConfig.trailDuration, progress)
		this.currentVisuals.trailColor = lerpColor(fromConfig.trailColor, toConfig.trailColor, progress)
	}

	/**
	 * Advances the state transition timer and updates the cursor's visual properties.
	 * @param {number} deltaTime - The time elapsed since the last frame.
	 * @private
	 */
	updateTransition(deltaTime) {
		if (this.transition.progress < 1.0) {
			this.transition.progress = Math.min(1.0, this.transition.progress + deltaTime / TRANSITION_DURATION)
		}
		this._updateInterpolatedVisuals()
		this.cursor.updateVisuals(this.currentVisuals, this.transition.progress)
	}

	/**
	 * Updates the trail effect.
	 * @param {PIXI.PointData} newPoint - The latest position of the cursor.
	 */
	updateTrail(newPoint) {
		const now = performance.now()
		const dx = newPoint.x - this.lastTrailPoint.x
		const dy = newPoint.y - this.lastTrailPoint.y

		// Only add a new point if it has moved a minimum distance
		if (dx * dx + dy * dy > this.minTrailPointDistanceSq) {
			// Use an object pool to avoid creating a new object every frame, reducing GC pressure.
			const point = this.trailPointPool.pop() || {}
			point.x = newPoint.x
			point.y = newPoint.y
			point.time = now
			this.trailPoints.push(point)

			this.lastTrailPoint.x = newPoint.x
			this.lastTrailPoint.y = newPoint.y
		}

		const trailDurationMs = this.currentVisuals.trailDuration * 1000

		// Remove old points and return them to the pool.
		// The trail will be drawn between points, so it will naturally disappear
		// as points are removed.
		while (this.trailPoints.length > 0 && now - this.trailPoints[0].time > trailDurationMs) {
			this.trailPointPool.push(this.trailPoints.shift())
		}

		// The trail is now based on the history of the smoothed visual position,
		// so we can draw the points directly without any modification.
		this.cursor.drawTrail(this.trailPoints, this.currentVisuals.trailColor, now, trailDurationMs)
	}

	/**
	 * Generates and caches all textures required for all defined states.
	 */
	async _generateAllStateTextures() {
		for (const stateName in this.states) {
			const stateConfig = this.states[stateName]
			const coreTexture = this._createGradientTexture(stateConfig.size, stateConfig.coreGradient)

			this.stateTextures[stateName] = { core: coreTexture }
		}
	}

	/**
	 * Creates a radial gradient texture.
	 * @param {number} size - The diameter of the texture.
	 * @param {Array<object>} colorStops - The color stops for the gradient.
	 * @returns {PIXI.Texture} The generated texture.
	 */
	_createGradientTexture(size, colorStops) {
		if (size <= 0 || !colorStops || colorStops.length === 0) {
			return PIXI.Texture.EMPTY
		}

		const graphics = new PIXI.Graphics()
		const gradient = new PIXI.FillGradient({
			type: 'radial',
			center: { x: 0.5, y: 0.5 },
			outerCenter: { x: 0.5, y: 0.5 },
			innerRadius: 0,
			outerRadius: 0.5,
			colorStops,
		})

		graphics.circle(size / 2, size / 2, size / 2).fill({ fill: gradient })

		const texture = this.renderer.textureGenerator.generateTexture({
			target: graphics,
			resolution: 2, // for smoother gradient
			frame: new PIXI.Rectangle(0, 0, size, size),
		})
		graphics.destroy()

		return texture
	}

	destroy() {
		if (this.cursor) {
			this.cursor.destroy()
			this.cursor = null
		}

		// Destroy all cached textures
		for (const stateName in this.stateTextures) {
			this.stateTextures[stateName].core?.destroy()
		}
		this.stateTextures = {}

		this.pixiApp = null
		this.renderer = null
		this.trailPointPool = []
	}
}
