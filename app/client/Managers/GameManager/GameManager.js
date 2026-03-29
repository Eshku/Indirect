const { layerManager } = await import(`@managers/LayerManager/LayerManager.js`)

//! why do I even have this?...

/**
 * Manages the core PIXI.Application instance and provides centralized access to it and other high-level game objects like layers.
 * @property {PIXI.Application | null} pixiApp - The main PIXI.Application instance for rendering.
 */
export class GameManager {
	constructor() {
		this.pixiApp = null
	}

	/**
	 * Initializes the GameManager, including setting up the PIXI Application.
	 */
	async init() {
		this.pixiApp = new PIXI.Application()
		await this.pixiApp.init({
			preference: 'webgpu',
			view: canvas,
			width: canvas.width,
			height: canvas.height,
			resolution: window.devicePixelRatio || 1,
			autoDensity: true,
			antialias: true,
			//roundPixels: true,
			autoStart: false,
			resizeTo: window,
		})

		if (this.pixiApp) {
			layerManager.setRootContainer(this.pixiApp.stage, this.pixiApp)
		} else {
			console.error('GameManager.init: PIXI.Application stage not available to set root for LayerManager.')
		}
	}

	/**
	 * @returns {PIXI.Application | null}
	 */
	getApp() {
		return this.pixiApp
	}

	getStage() {
		return this.pixiApp.stage
	}

	/**
	 * Gets a specific visual layer container.
	 * @param {string} name - The name of the layer ('background', 'main', 'ui').
	 * @returns {PIXI.Container | undefined} The PIXI.Container for the layer, or undefined if not found.
	 */
	getLayer(name) {
		return layerManager.getLayer(name)
	}
}

export const gameManager = new GameManager()
