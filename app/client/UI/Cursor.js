const { getCatmullRomPoint } = await import(`${PATH_CORE}/utils/spline.js`)

/**
 * A class representing the visual elements of the cursor.
 * It holds the PIXI.DisplayObjects and provides methods to manipulate them,
 * but does not contain any game logic for state or updates.
 */
export class Cursor {
	/**
	 * @param {PIXI.Application} pixiApp - The PIXI Application instance.
	 * @param {PIXI.Container} cursorLayer - The layer to add the cursor elements to.
	 */
	constructor(pixiApp, cursorLayer) {
		if (!pixiApp || !cursorLayer) {
			throw new Error('Cursor: PIXI.Application instance and cursor layer are required.')
		}

		this.pixiApp = pixiApp
		this.cursorLayer = cursorLayer

		// Create visual elements
		this.trail = new PIXI.Graphics()
		this.core = new PIXI.Sprite()
		this.core.anchor.set(0.5)

		this.corePrevious = new PIXI.Sprite() // For transitions
		this.corePrevious.anchor.set(0.5)
		this.corePrevious.visible = false

		// Add to the layer
		this.cursorLayer.addChild(this.trail, this.corePrevious, this.core)
	}

	/**
	 * Sets the texture for the core of the cursor.
	 * @param {PIXI.Texture} texture - The texture to use for the core.
	 */
	setCoreTexture(texture) {
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
	 * @param {PIXI.Texture} newTexture - The new texture to transition to.
	 */
	startCoreTransition(newTexture) {
		if (!this.core || !this.corePrevious || this.core.texture === newTexture) return

		// If there's no current texture, just set the new one without transition
		if (!this.core.texture || this.core.texture === PIXI.Texture.EMPTY) {
			this.setCoreTexture(newTexture)
			return
		}

		// The current core becomes the previous one
		this.corePrevious.texture = this.core.texture
		this.corePrevious.scale.copyFrom(this.core.scale)
		this.corePrevious.alpha = this.core.alpha
		this.corePrevious.visible = true

		// The new core starts invisible and will fade in
		this.core.texture = newTexture
		this.core.alpha = 0
	}

	/**
	 * Sets the position of the cursor on the screen.
	 * @param {number} x - The x-coordinate.
	 * @param {number} y - The y-coordinate.
	 */
	setScreenPosition(x, y) {
		if (!this.core) return
		this.core.position.set(x, y)
		if (this.corePrevious) {
			this.corePrevious.position.set(x, y)
		}
	}

	/**
	 * Updates the visual properties of the cursor, including transitions.
	 * @param {object} visuals - An object containing interpolated visual properties (size).
	 * @param {number} progress - The transition progress from 0 to 1.
	 */
	updateVisuals(visuals, progress) {
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
	 * Draws a smooth trail behind the cursor using a Catmull-Rom spline.
	 * @param {Array<PIXI.PointData & {time: number}>} points - The points that make up the trail, including timestamps.
	 * @param {number} color - The color of the trail.
	 * @param {number} currentTime - The current time from `performance.now()`.
	 * @param {number} trailDurationMs - The duration of the trail in milliseconds.
	 */
	drawTrail(points, color, currentTime, trailDurationMs) {
		this.trail.clear()
		if (points.length < 2 || trailDurationMs <= 0) {
			return
		}

		const segmentsPerCurve = 10 // Number of line segments to approximate each spline curve
		const tempPoint = { x: 0, y: 0 } // Reusable point object to avoid allocations

		// Iterate through each segment of the path (from point i to i+1)
		for (let i = 0; i < points.length - 1; i++) {
			// For Catmull-Rom, we need 4 points: p0, p1, p2, p3.
			// The curve is drawn between p1 and p2.
			const p1 = points[i]
			const p2 = points[i + 1]

			// To handle the ends of the trail, we duplicate the first and last points.
			const p0 = i > 0 ? points[i - 1] : p1
			const p3 = i < points.length - 2 ? points[i + 2] : p2

			let lastSplinePoint = { x: p1.x, y: p1.y } // Start of the current curve segment

			for (let j = 1; j <= segmentsPerCurve; j++) {
				const t = j / segmentsPerCurve
				const currentSplinePoint = getCatmullRomPoint(t, p0, p1, p2, p3, tempPoint)

				// Interpolate the time to calculate the alpha for this specific segment of the spline.
				const interpolatedTime = p1.time + (p2.time - p1.time) * t
				const age = currentTime - interpolatedTime
				const alpha = Math.max(0, 1.0 - age / trailDurationMs)

				// Draw a small line segment with the calculated alpha.
				this.trail
					.moveTo(lastSplinePoint.x, lastSplinePoint.y)
					.lineTo(currentSplinePoint.x, currentSplinePoint.y)
					.stroke({
						width: 2,
						color,
						alpha: alpha * 0.5, // Make it subtle
					})

				// The end of this segment is the start of the next.
				lastSplinePoint = { x: currentSplinePoint.x, y: currentSplinePoint.y }
			}
		}
	}

	/**
	 * Shows the cursor.
	 */
	show() {
		if (this.core) this.core.visible = true
	}

	/**
	 * Hides the cursor.
	 */
	hide() {
		if (this.core) this.core.visible = false
		if (this.corePrevious) this.corePrevious.visible = false
	}

	/**
	 * Destroys the cursor and its visual elements.
	 */
	destroy() {
		if (this.cursorLayer) {
			this.cursorLayer.removeChild(this.core, this.corePrevious, this.trail)
		}
		this.core?.destroy()
		this.corePrevious?.destroy()
		this.trail?.destroy()

		this.core = null
		this.trail = null
		this.pixiApp = null
		this.corePrevious = null
		this.cursorLayer = null
	}
}
