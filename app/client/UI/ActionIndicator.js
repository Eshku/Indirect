//! Legacy, as indicator and usage of items currently deleted for faster restructuring.

const INDICATOR_DEFAULTS = {
	ARC_RADIUS: 25, // The radius of the indicator arc itself.
	THICKNESS: 5, // Progress bar thickness
	TOTAL_ARC_DEGREES: 120, // A 120-degree arc

	// Positioning
	CURSOR_OFFSET: 0, // How far the indicator's center is from the cursor.
	POSITION_ANGLE_DEGREES: 0, // 0=right, 90=below, 180=left, 270=up

	// Shell (background arc)
	SHELL_THICKNESS: 5,
	SHELL_COLOR: 0xffffff,
	SHELL_ALPHA: 0.5,

	// Progress
	PROGRESS_COLOR: 0x2080ff,
	PROGRESS_ALPHA: 1,
}

/**
 * A UI element that displays a circular progress indicator, typically used for casting bars.
 * It is designed to be drawn near the cursor to keep the player's focus on the action.
 */
export class ActionIndicator {
	/**
	 * @param {PIXI.Container} layer - The layer to add the indicator to.
	 */
	constructor(layer) {
		// Main container for all parts of the indicator
		this.container = new PIXI.Container()
		layer.addChild(this.container)

		// --- Create visual components ---
		this.shellGraphics = new PIXI.Graphics() // For the background arc
		this.progressGraphics = new PIXI.Graphics() // For the progress arc

		// Add components to the container
		this.container.addChild(this.shellGraphics, this.progressGraphics)

		// Store settings as properties
		this.arcRadius = INDICATOR_DEFAULTS.ARC_RADIUS
		this.thickness = INDICATOR_DEFAULTS.THICKNESS
		this.totalArc = (INDICATOR_DEFAULTS.TOTAL_ARC_DEGREES * Math.PI) / 180

		this.cursorOffset = INDICATOR_DEFAULTS.CURSOR_OFFSET
		this.positionAngle = (INDICATOR_DEFAULTS.POSITION_ANGLE_DEGREES * Math.PI) / 180

		this.shellThickness = INDICATOR_DEFAULTS.SHELL_THICKNESS
		this.shellColor = INDICATOR_DEFAULTS.SHELL_COLOR
		this.shellAlpha = INDICATOR_DEFAULTS.SHELL_ALPHA

		this.progressColor = INDICATOR_DEFAULTS.PROGRESS_COLOR
		this.progressAlpha = INDICATOR_DEFAULTS.PROGRESS_ALPHA

		this.visible = false
		this.container.visible = false
	}

	/**
	 * Updates the visual representation of the indicator.
	 * @param {number} progress - The progress of the action, from 0.0 to 1.0.
	 * @param {PIXI.PointData} position - The position to draw the indicator at (usually the cursor).
	 */
	update(progress, position) {
		// Calculate the offset position for the indicator's container
		const offsetX = this.cursorOffset * Math.cos(this.positionAngle)
		const offsetY = this.cursorOffset * Math.sin(this.positionAngle)
		this.container.position.set(position.x + offsetX, position.y + offsetY)

		this.shellGraphics.clear()
		this.progressGraphics.clear()

		if (!this.visible || progress < 0) return

		// The arc is now centered around the configured position angle.
		const startAngle = this.positionAngle - this.totalArc / 2

		// 1. Draw the shell (background arc)
		this.shellGraphics.arc(0, 0, this.arcRadius, startAngle, startAngle + this.totalArc).stroke({
			width: this.shellThickness,
			color: this.shellColor,
			alpha: this.shellAlpha,
		})

		// 2. Draw the progress arc
		if (progress > 0) {
			const endAngle = startAngle + this.totalArc * progress
			this.progressGraphics.arc(0, 0, this.arcRadius, startAngle, endAngle).stroke({
				width: this.thickness,
				color: this.progressColor,
				alpha: this.progressAlpha,
			})
		}
	}

	show() {
		if (this.visible) return
		this.visible = true
		this.container.visible = true
	}

	hide() {
		if (!this.visible) return
		this.visible = false
		this.container.visible = false
		this.shellGraphics.clear()
		this.progressGraphics.clear()
	}

	destroy() {
		this.container.destroy({ children: true })
	}
}
