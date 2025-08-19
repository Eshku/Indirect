const { gameManager } = await import(`${PATH_MANAGERS}/GameManager/GameManager.js`)
const { layerManager } = await import(`${PATH_MANAGERS}/LayerManager/LayerManager.js`)

export class FpsCounter {
	constructor() {
		this.app = null // Will be set in init

		this.displayContainer = null
		this.background = null
		this.fpsText = null

		this.frames = 0
		this.elapsedTime = 0 // For manual FPS calculation over 1 second

		this.FPS_TEXT_STYLE = {
			fontFamily: 'Arial',
			fontSize: 16,
			fill: 0xffffff,
			align: 'left',
		}
		this.BACKGROUND_COLOR = 0x000000
		this.BACKGROUND_ALPHA = 0.5
		this.PADDING = 10 // Padding inside the background
		this.MARGIN = 10 // Margin from screen edges
	}

	async init() {
		this.app = gameManager.getApp()

		this.setupFpsDisplay()
	}

	update(deltaTime) {
		// Manual FPS calculation over 1-second intervals
		this.frames++
		this.elapsedTime += deltaTime // deltaTime is in seconds

		if (this.elapsedTime >= 1.0) {
			const fps = Math.round(this.frames / this.elapsedTime)
			const newFpsText = `FPS: ${fps}`
			if (this.fpsText.text !== newFpsText) {
				this.fpsText.text = newFpsText
				// If the text has changed, the layout needs to be recalculated
				// to adjust the background size and keep it right-aligned.
				this.onResize()
			}
			this.frames = 0
			this.elapsedTime = 0 // Reset completely for an accurate measurement next time
		}
	}

	setupFpsDisplay() {
		this.displayContainer = new PIXI.Container()
		this.background = new PIXI.Graphics()

		this.fpsText = new PIXI.Text('FPS: ...', this.FPS_TEXT_STYLE)
		this.fpsText.x = this.PADDING
		this.fpsText.y = this.PADDING

		this.displayContainer.addChild(this.background) // Background first, so it's behind text
		this.displayContainer.addChild(this.fpsText)

		const uiLayer = layerManager.getLayer('ui') // Get the UI layer

		uiLayer.addChild(this.displayContainer) // Add FPS counter to the UI layer

		// Initial layout update
		this.onResize()

		// Listen for window resize events to reposition the counter
		this.app.renderer.on('resize', this.onResize, this)
	}

	onResize() {
		const bgWidth = this.fpsText.width + this.PADDING * 2
		const bgHeight = this.fpsText.height + this.PADDING * 2

		this.background.clear()
		this.background.beginFill(this.BACKGROUND_COLOR, this.BACKGROUND_ALPHA)
		this.background.drawRect(0, 0, bgWidth, bgHeight)
		this.background.endFill()

		this.displayContainer.x = this.app.screen.width - bgWidth - this.MARGIN
		this.displayContainer.y = this.MARGIN
	}

	/**
	 * Cleans up the FpsCounter, removing it from the stage and removing event listeners.
	 * This should be called by the SystemManager when the game shuts down.
	 */
	destroy() {
		this.app.renderer.off('resize', this.onResize, this)

		if (this.displayContainer.parent) {
			this.displayContainer.parent.removeChild(this.displayContainer)
		}
		this.displayContainer.destroy({ children: true })
		this.displayContainer = null

		this.app = null
		this.background = null
		this.fpsText = null
	}
}
