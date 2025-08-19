/**
 * Manages loading, storing, and retrieving game assets, primarily PIXI.Texture and PIXI.Sprite objects.
 * It maintains a manifest of asset names to their paths and caches loaded textures to avoid redundant loading.
 * @property {Map<string, PIXI.Texture>} assets - Caches loaded PIXI.Texture objects, keyed by their unique asset name.
 * @property {Map<string, string>} assetManifest - Maps unique asset names to their corresponding file paths.
 */

export class AssetManager {
	constructor() {
		this.assets = new Map() // Stores PIXI.Texture objects by assetName
		this.assetManifest = new Map() // Stores assetName -> assetPath
	}

	async init() {}

	/**
	 * Registers the path for an asset name. This allows the AssetManager
	 * to know where to load an asset from if only its name is provided later.
	 * @param {string} assetName - A unique name to identify the asset.
	 * @param {string} assetPath - The path to the asset file.
	 */
	registerAssetMetadata(assetName, assetPath) {
		if (typeof assetName !== 'string' || !assetName) {
			console.error('AssetManager.registerAssetMetadata: assetName must be a non-empty string.')
			return
		}
		if (typeof assetPath !== 'string' || !assetPath) {
			console.error(`AssetManager.registerAssetMetadata: assetPath for "${assetName}" must be a non-empty string.`)
			return
		}
		this.assetManifest.set(assetName, assetPath)
	}

	/**
	 * Loads an asset (e.g., an image) from a given path and stores its texture under a specified name.
	 * @param {string} assetName - A unique name to identify the asset.
	 * @param {string} assetPath - The path to the asset file.
	 * @returns {Promise<boolean>} True if the asset was successfully stored or already existed, false otherwise.
	 */
	async loadAsset(assetName, assetPath = null) {
		if (typeof assetName !== 'string' || !assetName) {
			console.error('AssetManager.loadAsset: assetName must be a non-empty string.')
			return false
		}
		if (typeof assetPath !== 'string' || !assetPath) {
			console.error(`AssetManager.loadAsset: assetPath for "${assetName}" must be a non-empty string.`)
			return false
		}

		// If assetPath is not provided, try to get it from the manifest
		const pathForLoading = assetPath || this.assetManifest.get(assetName)

		if (!pathForLoading) {
			console.error(`AssetManager.loadAsset: assetPath for "${assetName}" not provided and not found in manifest.`)
			return false
		}

		if (this.assets.has(assetName)) {
			// console.warn(`AssetManager: Asset "${assetName}" is already loaded.`);
			return true
		}
		try {
			const texture = await PIXI.Assets.load(pathForLoading)
			if (texture) {
				this.assets.set(assetName, texture)
				// If assetPath was provided (meaning it might not be in manifest yet), register it.
				if (assetPath && !this.assetManifest.has(assetName)) {
					this.assetManifest.set(assetName, assetPath)
				}
				return true
			} else {
				console.error(`AssetManager: PIXI.Assets.load returned undefined for "${assetName}" from "${pathForLoading}".`)
				return false
			}
		} catch (error) {
			console.error(`AssetManager: Failed to load asset "${assetName}" from "${pathForLoading}":`, error)
			return false
		}
	}
	/**
	 * Retrieves a loaded asset's texture.
	 * @param {string} assetName - The name of the asset.
	 * @returns {PIXI.Texture | undefined} The texture if found, otherwise undefined.
	 */
	getAsset(assetName) {
		if (!this.assets.has(assetName)) {
			// console.warn(`AssetManager: Texture for asset "${assetName}" not found. Ensure it has been loaded.`);
			return undefined
		}
		return this.assets.get(assetName)
	}

	/**
	 * Creates a sprite from a loaded asset.
	 * @param {string} assetName - The name of the loaded asset to use.
	 * @param {object} [options={}] - Optional properties to apply to the sprite (e.g., x, y, anchor, scale, tint).
	 *                                `options.anchor` can be a number (for x & y) or an object {x, y}.
	 * @returns {PIXI.Sprite | null} The created sprite, or null if the asset is not found or container is invalid.
	 */
	async createSprite(assetName, options = {}) {
		let texture = this.getAsset(assetName)
		if (!texture) {
			// console.log(`AssetManager.createSprite: Texture for "${assetName}" not found. Attempting to load...`);
			const loaded = await this.loadAsset(assetName) // loadAsset will use manifest if path not given
			if (!loaded) {
				console.error(`AssetManager.createSprite: Failed to load asset "${assetName}" on demand.`)
				return null
			}
			texture = this.getAsset(assetName)
			if (!texture) {
				// Should not happen if loadAsset succeeded
				console.error(`AssetManager.createSprite: Asset "${assetName}" loaded but texture still not available.`)
				return null
			}
		}

		const sprite = PIXI.Sprite.from(texture)
		// Destructure anchor for special handling, apply other options directly.
		const { anchor, ...otherOptions } = options
		Object.assign(sprite, otherOptions)

		if (anchor !== undefined) {
			if (typeof anchor === 'number') {
				sprite.anchor.set(anchor)
			} else if (typeof anchor === 'object' && anchor !== null) {
				sprite.anchor.set(anchor.x ?? 0, anchor.y ?? 0)
			} else {
				console.warn(
					`AssetManager.createSprite: Invalid anchor type for asset "${assetName}". Expected number or object.`
				)
			}
		}

		return sprite
	}

	/**
	 * Adds a PIXI.Sprite to the specified PIXI.Container.
	 * @param {PIXI.Sprite} sprite - The sprite instance to add.
	 * @param {PIXI.Container} container - The PixiJS container (e.g., app.stage) to add the sprite to.
	 * @returns {PIXI.Sprite | null} The added sprite, or null if inputs are invalid.
	 */
	addToScene(sprite, container) {
		if (!(sprite instanceof PIXI.Sprite)) {
			console.error('AssetManager.addToScene: Invalid sprite provided. Expected a PIXI.Sprite.')
			return null
		}
		if (!(container instanceof PIXI.Container)) {
			console.error(`AssetManager.addToScene: Invalid container provided. Expected a PIXI.Container.`)
			return null
		}
		return container.addChild(sprite)
	}

	/**
	 * Removes a sprite from its parent container and optionally destroys it.
	 * @param {PIXI.Sprite} sprite - The sprite instance to remove.
	 * @param {object | boolean | undefined} [destroyOptions={ children: true, texture: false, baseTexture: false }]
	 *                 - Options for sprite.destroy(). See PIXI.Sprite#destroy documentation.
	 *                 - Set to `null` or `undefined` to only remove from parent without destroying.
	 *                 - Default preserves textures managed by AssetManager.
	 */
	removeFromScene(sprite, destroyOptions = { children: true, texture: false, baseTexture: false }) {
		if (!(sprite instanceof PIXI.Sprite)) {
			// Check if PIXI is available
			console.error('AssetManager.removeFromScene: Invalid sprite provided.')
			return
		}
		if (sprite.parent) {
			sprite.parent.removeChild(sprite)
		}
		if (destroyOptions !== null && destroyOptions !== undefined) {
			sprite.destroy(destroyOptions)
		}
	}
}

export const assetManager = new AssetManager()
window.assetManager = assetManager // for debugging