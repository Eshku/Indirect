/**
 * Manages the visual layers (PIXI.Containers) of the application, ensuring they are ordered correctly.
 * @property {Map<string, PIXI.DisplayObject>} layers - A map of layer names to their PIXI.Container or other DisplayObject instances.
 * @property {PIXI.Container | null} rootContainer - The main stage where all layers are added.
 * @property {PIXI.Application | null} pixiApp - The PIXI.Application instance. May be needed for screen dimensions.
 */
export class LayerManager {
	constructor() {
		this.layers = new Map() // Will now store any named DisplayObject
		this.rootContainer = null
		this.pixiApp = null
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
		this.pixiApp = pixiApp
		this.layers.clear()
		this.rootContainer.removeChildren()
	}

	/**
	 * Dynamically adds a new visual layer (a PIXI.Container) to the scene.
	 * @param {string} name - A unique name for the layer.
	 * @param {object} [options={}] - Configuration for the layer.
	 * @param {string|PIXI.Container} [options.parent] - The parent container for this layer. Can be a layer name or a PIXI.Container instance. Defaults to the root container.
	 * @param {number} [options.order] - The z-index (stacking order) within the parent. Lower numbers are rendered first.
	 * @returns {PIXI.Container | undefined} The created container, or undefined on failure.
	 */
	addLayer(name, { parent, order } = {}) {
		if (!this.rootContainer) {
			console.error(`LayerManager.addLayer: Cannot add layer "${name}". Root container not set.`)
			return undefined
		}
		if (this.layers.has(name)) {
			console.warn(`LayerManager.addLayer: A layer with the name "${name}" already exists.`)
			return this.getLayer(name) // Return the existing container if it's a layer
		}

		let parentContainer = this.rootContainer
		if (parent) {
			if (typeof parent === 'string') {
				parentContainer = this.getLayer(parent)
				if (!parentContainer) {
					console.error(`LayerManager.addLayer: Parent layer "${parent}" not found for new layer "${name}".`)
					return undefined
				}
			} else if (parent instanceof PIXI.Container) {
				parentContainer = parent
			} else {
				console.error(`LayerManager.addLayer: Invalid parent type for layer "${name}".`)
				return undefined
			}
		}

		const newLayer = new PIXI.Container()
		this.layers.set(name, newLayer)

		if (order !== undefined) {
			parentContainer.addChildAt(newLayer, order)
		} else {
			parentContainer.addChild(newLayer)
		}

		return newLayer
	}

	/**
	 * Gets a specific visual layer container.
	 * @param {string} name - The name of the layer.
	 * @returns {PIXI.Container | undefined} The PIXI.Container for the layer, or undefined if not found.
	 */
	getLayer(name) {
		const item = this.layers.get(name)
		if (!item) {
			console.warn(`LayerManager.getLayer: Layer with name "${name}" not found.`)
			return undefined
		}
		// Ensure we only return containers for getLayer
		if (item instanceof PIXI.Container) {
			return item
		}
		console.warn(`LayerManager.getLayer: Found an object named "${name}", but it is not a PIXI.Container layer.`)
		return undefined
	}

	/**
	 * Stores a generic PIXI.DisplayObject by name for easy retrieval.
	 * This is useful for objects that aren't layers themselves but need to be globally accessible (e.g., a background sprite).
	 * @param {string} name - The unique name to store the object under.
	 * @param {PIXI.DisplayObject} object - The PIXI object to store.
	 */
	store(name, object) {
		if (this.layers.has(name)) {
			console.warn(`LayerManager.store: An object with the name "${name}" already exists. It will be overwritten.`)
		}
		// Use duck-typing to check for a PIXI.DisplayObject. The PIXI.DisplayObject
		// constructor is not reliably exposed on the global PIXI object in all versions/builds,
		// making `instanceof PIXI.DisplayObject` unreliable.
		if (!object || typeof object.destroy !== 'function' || typeof object.visible !== 'boolean') {
			console.error(`LayerManager.store: Object for "${name}" is not a valid PIXI DisplayObject.`)
			return
		}
		this.layers.set(name, object)
	}

	/**
	 * Retrieves any stored PIXI.DisplayObject by its name.
	 * @param {string} name - The name of the object to retrieve.
	 * @returns {PIXI.DisplayObject | undefined} The object, or undefined if not found.
	 */
	get(name) {
		return this.layers.get(name)
	}
}

export const layerManager = new LayerManager()
