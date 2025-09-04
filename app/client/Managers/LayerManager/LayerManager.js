/**
 * Manages the visual layers (PIXI.Containers) of the application, ensuring they are ordered correctly.
 * @property {Map<string, PIXI.Container>} layers - A map of layer names to their PIXI.Container instances.
 * @property {PIXI.Container | null} rootContainer - The main stage where all layers are added.
 * @property {PIXI.Application | null} pixiApp - The PIXI.Application instance. May be needed for screen dimensions.
 * @property {string[]} layerOrder - The default order in which layers are created.
 */
export class LayerManager {
	constructor() {
		this.layers = new Map()
		this.rootContainer = null
		this.pixiApp = null
		this.layerOrder = [
			'visualBackground',
			'gameContainer', // This will contain other layers that move with the camera
			'ui',
			'cursor',
		]

		// Layers that will be children of 'gameContainer'
		this.gameLayerOrder = ['backgroundBuild', 'gameWorld', 'gameActors']
	}

	async init() {}

	/**
	 * Sets the root PIXI.Container where all layers will be added.
	 * Typically, this is the PIXI.Application's stage.
	 * @param {PIXI.Container} root - The root container.
	 * @param {PIXI.Application} pixiApp - The PIXI.Application instance for screen dimensions.
	 */
	setRootContainer(root, pixiApp) {
		if (!(root instanceof PIXI.Container)) {
			console.error('LayerManager.setRootContainer: Provided root is not a PIXI.Container.')
			return
		}
		if (!pixiApp) {
			console.error('LayerManager.setRootContainer: pixiApp instance not provided.')
			return
		}
		this.rootContainer = root
		this.pixiApp = pixiApp // Store pixiApp instance
		this._createDefaultLayers()
	}

	_createDefaultLayers() {
		if (!this.rootContainer) {
			console.error('LayerManager._createDefaultLayers: Root container not set. Cannot create layers.')
			return
		}
		this.layers.clear() // Clear any existing layers
		this.rootContainer.removeChildren() // Clear root container

		// Create the main layers
		for (const name of this.layerOrder) {
			const container = new PIXI.Container()
			this.layers.set(name, container)
			this.rootContainer.addChild(container)
		}

		// Create the sub-layers inside gameContainer
		const gameContainer = this.layers.get('gameContainer')
		for (const name of this.gameLayerOrder) {
			const container = new PIXI.Container()
			// Also add to the main layers map for easy access
			this.layers.set(name, container)
			gameContainer.addChild(container)
		}
	}

	/**
	 * Gets a specific visual layer container.
	 * @param {string} name - The name of the layer.
	 * @returns {PIXI.Container | undefined} The PIXI.Container for the layer, or undefined if not found.
	 */
	getLayer(name) {
		return this.layers.get(name)
	}
}

export const layerManager = new LayerManager()
