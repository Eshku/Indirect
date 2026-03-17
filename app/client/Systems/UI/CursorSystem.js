const { lerp, lerpColor } = await import(`@core/utils/lerp.js`)
const { Easing } = await import(`@core/utils/easing.js`)
const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const { getCatmullRomPoint } = await import(`@core/utils/spline.js`)

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
 * A system dedicated to creating, managing, and updating  cursor.
 * It controls  cursor's position, visual state, and special effects
 * like trails.
 * - It hooks into  renderer's 'prerender' event to update its position with low latency.
 * - It runs in  main update loop to check for interactions with UI elements and change state accordingly.
 */

const { position, cursorTag, cursorState, playerTag } = ecs.getTypeIDs()

//! Mesh Ribbon Trail (Vertex Strip + Per-Vertex Alpha = single draw call, no clear)

export class CursorSystem {
	/**
	 * Initializes the system. This is called by the SystemManager once.
	 */
	async init() {
		// --- Component/Entity State ---

		this.cursorStateComponent = cursorState
		this.cursorQuery = this.getQuery({ with: [cursorTag] })

		this.playerQuery = this.getQuery({ with: [playerTag, position] })

		// --- Visual State Management ---
		this.states = DEFAULT_STATES
		this.cursorStateFlags = ecs.getConstantsForProperty('cursorState', 'flags')
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
		this.cursorLayer = layerManager.getLayer('cursor')

		// --- Merged from Cursor constructor ---
		if (!this.pixiApp || !this.cursorLayer) {
			throw new Error('CursorSystem: PIXI.Application instance and cursor layer are required.')
		}

		// Create visual elements directly as system properties
		this.trail = new PIXI.Graphics()
		this.core = new PIXI.Sprite()
		this.core.anchor.set(0.5)

		this.corePrevious = new PIXI.Sprite() // For transitions
		this.corePrevious.anchor.set(0.5)
		this.corePrevious.visible = false

		this.cursorLayer.addChild(this.trail, this.corePrevious, this.core)

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

		// Pre-compile a single payload for updating both position and state.
		const { payload, mutators } = this.compile({
			position: { x: 0, y: 0 },
			cursorState: { flags: 0 },
		})
		this.cursorUpdatePayload = payload
		this.cursorUpdateMutators = mutators

		// Pre-generate all state textures
		await this._generateAllStateTextures()

		// Snap initial positions to  current hardware cursor position
		const pointer = this.renderer.events.pointer
		this.hardwarePosition.x = pointer.global.x
		this.hardwarePosition.y = pointer.global.y
		this.visualPosition.x = this.hardwarePosition.x
		this.visualPosition.y = this.hardwarePosition.y

		// Set initial state and show
		this.currentVisuals = { ...this.states[this.targetStateName] }
		this._setCoreTexture(this.stateTextures[this.targetStateName].core)
		this._updateVisuals(this.currentVisuals, 1.0)
		this._setScreenPosition(this.visualPosition.x, this.visualPosition.y)
		this._show()
	}

	/**
	 * Runs every frame to check for interactions with UI elements and update the cursor state.
	 * @param {object} context - The frame context object.
	 */
	update({ deltaTime }) {
		// Update hardware position from input
		const pointer = this.renderer.events.pointer
		this.hardwarePosition.x = pointer.global.x
		this.hardwarePosition.y = pointer.global.y

		const positionChanged =
			this.hardwarePosition.x !== this.previousHardwarePosition.x ||
			this.hardwarePosition.y !== this.previousHardwarePosition.y

		// Update previous position for the next frame's check
		this.previousHardwarePosition.x = this.hardwarePosition.x
		this.previousHardwarePosition.y = this.hardwarePosition.y

		// Determine if  visual cursor has caught up to the hardware cursor
		const dx = this.hardwarePosition.x - this.visualPosition.x
		const dy = this.hardwarePosition.y - this.visualPosition.y
		this.isSettled = Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1

		// Update visual state and position only if the cursor has moved or is transitioning.
		if (positionChanged || !this.isSettled || this.transition.progress < 1.0) {
			if (positionChanged) {
				this.updateState()
			}
			this.updatePosition(deltaTime)
			this.updateTransition(deltaTime)
		}

		//  update  world position of the cursor entity.

		const playerPosition = this.getComponent(this.playerId, position)
		const { gameManager } = engine.getManagers()
		const screenWidth = gameManager.getApp().screen.width
		const screenHeight = gameManager.getApp().screen.height

		let worldX = this.visualPosition.x
		let worldY = this.visualPosition.y

		// Convert screen-space visual position to world-space coordinates.
		// This accounts for camera panning by using the player's position as the camera's focus.
		worldX = this.visualPosition.x + playerPosition.x - screenWidth / 2
		worldY = -this.visualPosition.y + playerPosition.y + screenHeight / 2

		// Update position and state components with a single command
		const mutators = this.cursorUpdateMutators
		mutators.position.x[0] = worldX
		mutators.position.y[0] = worldY

		const stateFlag = this.cursorStateFlags[this.targetStateName.toUpperCase()] || this.cursorStateFlags.DEFAULT
		mutators.cursorState.flags[0] = stateFlag

		this.setComponentsData(this.cursorEntityId, this.cursorUpdatePayload)

		// update  trail effect.
		this.updateTrail(this.visualPosition)
	}

	/**
	 * Changes  active state of  cursor and updates its visuals.
	 * @param {string} stateName - The name of the state to activate.
	 */
	setState(stateName) {
		if (stateName === this.targetStateName || !this.states[stateName]) {
			return
		}

		// If a transition is in progress, start  new one from the current interpolated state.
		if (this.transition.progress < 1.0) {
			this._updateInterpolatedVisuals()
			// Create a temporary state config to transition from by creating a snapshot of  current visuals.
			this.states._current = { ...this.currentVisuals }
			this.sourceStateName = '_current'
		} else {
			this.sourceStateName = this.targetStateName
		}

		this.targetStateName = stateName
		this.transition.progress = 0

		// Tell  Cursor view to prepare for a texture transition
		const newTexture = this.stateTextures[this.targetStateName].core
		this._startCoreTransition(newTexture)
	}

	/**
	 * Determines  correct cursor state based on what  hardware cursor is hovering over.
	 * @private
	 */
	updateState() {
		const { uiManager } = engine.getManagers()
		// TODO: Implement entity hover detection
		const hoveredEntity = null // Placeholder for now
		const hoveredElement = uiManager.getHoveredElement(this.hardwarePosition)

		// Determine  new state based on a priority system
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
	 * @param {number} deltaTime -  time elapsed since  last frame.
	 * @private
	 */
	updatePosition(deltaTime) {
		if (this.isSettled) {
			// Snap to  final position to avoid infinitesimal lerping.

			this.visualPosition.x = this.hardwarePosition.x
			this.visualPosition.y = this.hardwarePosition.y
		} else {
			// A frame-rate independent lerp formula is used for consistent smoothing.
			const lerpFactor = 1 - Math.exp(-this.lerpSpeed * deltaTime)
			this.visualPosition.x = lerp(this.visualPosition.x, this.hardwarePosition.x, lerpFactor)
			this.visualPosition.y = lerp(this.visualPosition.y, this.hardwarePosition.y, lerpFactor)
		}

		// Set  cursor sprite's position to  smoothed visual position.
		this._setScreenPosition(this.visualPosition.x, this.visualPosition.y)
	}

	/**
	 * Calculates  current visual properties by interpolating between states.
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
	 * Advances  state transition timer and updates  cursor's visual properties.
	 * @param {number} deltaTime -  time elapsed since  last frame.
	 * @private
	 */
	updateTransition(deltaTime) {
		if (this.transition.progress < 1.0) {
			this.transition.progress = Math.min(1.0, this.transition.progress + deltaTime / TRANSITION_DURATION)
		}
		this._updateInterpolatedVisuals()
		this._updateVisuals(this.currentVisuals, this.transition.progress)
	}

	/**
	 * Updates  trail effect.
	 * @param {PIXI.PointData} newPoint -  latest position of  cursor.
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
		//  trail will be drawn between points, so it will naturally disappear
		// as points are removed.
		while (this.trailPoints.length > 0 && now - this.trailPoints[0].time > trailDurationMs) {
			this.trailPointPool.push(this.trailPoints.shift())
		}

		//  trail is now based on  history of  smoothed visual position,
		// so we can draw  points directly without any modification.
		this._drawTrail(this.trailPoints, this.currentVisuals.trailColor, now, trailDurationMs)
	}

	/**
	 * Sets  texture for  core of  cursor.
	 * @param {PIXI.Texture} texture -  texture to use for  core.
	 * @private
	 */
	_setCoreTexture(texture) {
		if (this.core) {
			this.core.texture = texture
			this.core.alpha = 1
		}
		if (this.corePrevious) {
			this.corePrevious.visible = false
		}
	}

	/**
	 * Initiates a smooth transition between two core textures.
	 * @param {PIXI.Texture} newTexture -  new texture to transition to.
	 * @private
	 */
	_startCoreTransition(newTexture) {
		if (!this.core || !this.corePrevious || this.core.texture === newTexture) return

		// If there's no current texture, just set  new one without transition
		if (!this.core.texture || this.core.texture === PIXI.Texture.EMPTY) {
			this._setCoreTexture(newTexture)
			return
		}

		//  current core becomes  previous one
		this.corePrevious.texture = this.core.texture
		this.corePrevious.scale.copyFrom(this.core.scale)
		this.corePrevious.alpha = this.core.alpha
		this.corePrevious.visible = true

		//  new core starts invisible and will fade in
		this.core.texture = newTexture
		this.core.alpha = 0
	}

	/**
	 * Sets  position of the cursor on the screen.
	 * @param {number} x -  x-coordinate.
	 * @param {number} y -  y-coordinate.
	 * @private
	 */
	_setScreenPosition(x, y) {
		if (!this.core) return
		this.core.position.set(x, y)
		if (this.corePrevious) {
			this.corePrevious.position.set(x, y)
		}
	}

	/**
	 * Updates  visual properties of the cursor, including transitions.
	 * @param {object} visuals - An object containing interpolated visual properties (size).
	 * @param {number} progress -  transition progress from 0 to 1.
	 * @private
	 */
	_updateVisuals(visuals, progress) {
		if (!this.core) return

		if (this.core.texture && this.core.texture.width > 0) {
			const scale = visuals.size / this.core.texture.width
			this.core.scale.set(scale)
		}

		if (this.corePrevious.visible && this.corePrevious.texture && this.corePrevious.texture.width > 0) {
			const prevScale = visuals.size / this.corePrevious.texture.width
			this.corePrevious.scale.set(prevScale)
		}

		// Update alpha for cross-fade
		this.core.alpha = progress
		this.corePrevious.alpha = 1 - progress

		if (progress >= 1) {
			this.corePrevious.visible = false
		}
	}

	/**
	 * Draws a smooth trail behind  cursor using a Catmull-Rom spline.
	 * @param {Array<PIXI.PointData & {time: number}>} points -  points that make up  trail, including timestamps.
	 * @param {number} color -  color of the trail.
	 * @param {number} currentTime -  current time from `performance.now()`.
	 * @param {number} trailDurationMs -  duration of  trail in milliseconds.
	 * @private
	 */
	_drawTrail(points, color, currentTime, trailDurationMs) {
		this.trail.clear()
		if (points.length < 2 || trailDurationMs <= 0) {
			return
		}

		const segmentsPerCurve = 10 // Number of line segments to approximate each spline curve
		const tempPoint = { x: 0, y: 0 } // Reusable point object to avoid allocations
		// Reusable point object for  start of each line segment to avoid allocations in the loop.
		const lastSplinePoint = { x: 0, y: 0 }

		// Iterate through each segment of the path (from point i to i+1)
		for (let i = 0; i < points.length - 1; i++) {
			// For Catmull-Rom, we need 4 points: p0, p1, p2, p3.
			//  curve is drawn between p1 and p2.
			const p1 = points[i]
			const p2 = points[i + 1]

			// To handle the ends of the trail, we duplicate the first and last points.
			const p0 = i > 0 ? points[i - 1] : p1
			const p3 = i < points.length - 2 ? points[i + 2] : p2

			// Set starting point for this curve segment.
			lastSplinePoint.x = p1.x
			lastSplinePoint.y = p1.y

			for (let j = 1; j <= segmentsPerCurve; j++) {
				const t = j / segmentsPerCurve
				const currentSplinePoint = getCatmullRomPoint(t, p0, p1, p2, p3, tempPoint)

				// Interpolate time to calculate  alpha for this specific segment of  spline.
				const interpolatedTime = p1.time + (p2.time - p1.time) * t
				const age = currentTime - interpolatedTime
				const alpha = Math.max(0, 1.0 - age / trailDurationMs)

				// Draw a small line segment with  calculated alpha.
				this.trail
					.moveTo(lastSplinePoint.x, lastSplinePoint.y)
					.lineTo(currentSplinePoint.x, currentSplinePoint.y)
					.stroke({
						width: 2,
						color,
						alpha: alpha * 0.5, // Make it subtle
					})

				//  end of this segment is  start of  next.
				lastSplinePoint.x = currentSplinePoint.x
				lastSplinePoint.y = currentSplinePoint.y
			}
		}
	}

	/**
	 * Shows  cursor.
	 * @private
	 */
	_show() {
		if (this.core) this.core.visible = true
	}

	/**
	 * Hides  cursor.
	 * @private
	 */
	_hide() {
		if (this.core) this.core.visible = false
		if (this.corePrevious) this.corePrevious.visible = false
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
		if (this.cursorLayer) {
			this.cursorLayer.removeChild(this.core, this.corePrevious, this.trail)
		}

		this.core?.destroy()
		this.corePrevious?.destroy()
		this.trail?.destroy()

		// Destroy all cached textures
		for (const stateName in this.stateTextures) {
			this.stateTextures[stateName].core?.destroy()
		}
		this.stateTextures = {}

		this.core = null
		this.trail = null
		this.corePrevious = null
		this.cursorLayer = null

		this.pixiApp = null
		this.renderer = null
		this.trailPointPool = []
	}
}
