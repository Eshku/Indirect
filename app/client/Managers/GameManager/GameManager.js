const { layerManager } = await import(`${PATH_MANAGERS}/LayerManager/LayerManager.js`)

/**
 * Manages the core PIXI.Application instance and provides centralized access to it and other high-level game objects like layers.
 * @property {PIXI.Application | null} pixiApp - The main PIXI.Application instance for rendering.
 */
export class GameManager {
	constructor() {
		this.pixiApp = null

		// --- Isometric Projection Constants ---
		// The angle of the isometric projection.
		this.ISO_ANGLE = 40 * (Math.PI / 180)
		this.Z_FACTOR_X = -Math.cos(this.ISO_ANGLE) // Negative for a right-leaning view /___/
		this.Z_FACTOR_Y = Math.sin(this.ISO_ANGLE)
	}

	/**
	 * Initializes the GameManager, including setting up the PIXI Application.
	 */
	async init() {
		this.pixiApp = new PIXI.Application() // Constructor is not async
		await this.pixiApp.init({
			view: canvas, // Assuming 'canvas' is globally available or passed differently
			width: canvas.width,
			height: canvas.height,
			// backgroundColor: 0x333333, // Removed to allow image background
			resolution: window.devicePixelRatio || 1,
			autoDensity: true,
			autoStart: false, // We will start it manually in client.js's setupLoop
			resizeTo: window,
		})

		if (this.pixiApp) {
			layerManager.setRootContainer(this.pixiApp.stage, this.pixiApp) // Pass pixiApp to LayerManager
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

	/**
	 * Gets the isometric projection settings used for rendering.
	 * @returns {{ISO_ANGLE: number, Z_FACTOR_X: number, Z_FACTOR_Y: number}}
	 */
	getIsometricSettings() {
		return {
			ISO_ANGLE: this.ISO_ANGLE,
			Z_FACTOR_X: this.Z_FACTOR_X,
			Z_FACTOR_Y: this.Z_FACTOR_Y,
		}
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

	// Future methods for GameManager:
	// pauseGame() {}
	// resumeGame() {}
	// loadLevel(levelName) {}

	//! if we are going to store game state there - keep track of "who" touched game state - which class or whatnot and track new state.
}

export const gameManager = new GameManager()
