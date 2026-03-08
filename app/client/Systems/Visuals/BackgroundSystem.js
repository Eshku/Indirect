const { engine } = await import(`@client/Engine.js`)
const { gameManager, layerManager } = engine.getManagers()

/**
 * Procedurally generates a multi-layered, tileable starfield texture for a more dynamic background.
 * @param {PIXI.Application} app - The Pixi application instance.
 * @param {number} width - The width of the texture.
 * @param {number} height - The height of the texture.
 * @param {object[]} layers - Configuration for each star layer.
 * @returns {PIXI.Texture} The generated texture.
 */
function createStarfieldTexture(app, width, height, layers) {
	const graphics = new PIXI.Graphics()

	// A dark blue/black for space
	graphics.rect(0, 0, width, height).fill(0x0c0c1a)

	// Generate stars for each layer
	for (const layer of layers) {
		for (let i = 0; i < layer.count; i++) {
			const x = Math.random() * width
			const y = Math.random() * height
			const radius = layer.minRadius + Math.random() * (layer.maxRadius - layer.minRadius)
			const alpha = layer.minAlpha + Math.random() * (layer.maxAlpha - layer.minAlpha)
			const color = Math.random() > 0.2 ? 0xffffff : 0xaaccff // Most are white, some are blueish

			graphics.circle(x, y, radius).fill({ color, alpha })
		}
	}

	return app.renderer.generateTexture(graphics)
}

export class BackgroundSystem {
	async init() {
		this.app = gameManager.getApp()

		this.app.renderer.background.color = 0x0c0c1a // Fallback color

		// Define multiple layers for a parallax/depth effect
		const starLayers = [
			{ count: 200, minRadius: 0.2, maxRadius: 0.7, minAlpha: 0.3, maxAlpha: 0.6 }, // Dim, distant stars
			{ count: 100, minRadius: 0.5, maxRadius: 1.1, minAlpha: 0.5, maxAlpha: 0.8 }, // Mid-ground stars
			{ count: 50, minRadius: 0.8, maxRadius: 1.5, minAlpha: 0.7, maxAlpha: 1.0 }, // Bright, closer stars
		]

		const starfieldTexture = createStarfieldTexture(this.app, 512, 512, starLayers)

		this.tilingSprite = new PIXI.TilingSprite({
			texture: starfieldTexture,
			width: this.app.screen.width,
			height: this.app.screen.height,
		})

		layerManager.getLayer('backgroundContainer').addChild(this.tilingSprite)

		// Store a reference for other systems (like CameraSystem) to use.
		layerManager.store('starfieldSprite', this.tilingSprite)

		// Handle resize events
		this.app.renderer.on('resize', this.onResize, this)
	}

	onResize(width, height) {
		this.tilingSprite.width = width
		this.tilingSprite.height = height
	}

	destroy() {
		// For HMR and general cleanup, it's crucial to remove listeners.
		if (this.app) {
			this.app.renderer.off('resize', this.onResize, this)
			this.app = null
		}

		// Clean up resources if the system is ever destroyed
		if (this.tilingSprite) {
			this.tilingSprite.destroy()
			this.tilingSprite = null
		}
		layerManager.remove('starfieldSprite')
	}
}
