/**
 * Manages loading, storing, and retrieving game assets.
 * It supports two main patterns:
 * 1.  **Direct Access (User-Friendly):** Methods like `createSprite` for immediate, manual use where
 *     the developer manages the sprite lifecycle directly.
 * 2.  **Managed Reference (Performance):** Methods like `acquireSpriteRef` for use within the ECS.
 *     This pattern stores sprites in a pool and provides a lightweight numeric reference (`Ref`)
 *     to them. Systems use this `Ref` to efficiently retrieve sprites, and it's the system's
 *     responsibility to release the `Ref` when the entity is destroyed.
 *
 * @property {Map<string, PIXI.Texture>} assets - Caches loaded PIXI.Texture objects, keyed by their unique asset name.
 * @property {Map<string, string>} assetManifest - Maps unique asset names to their corresponding file paths.
 * @property {PIXI.DisplayObject[]} _managedDisplayObjects - A pool of managed PIXI.DisplayObject instances. The index is the `Ref`.
 * @property {number[]} _freeDisplayObjectRefs - A stack of available indices (Refs) in the `_managedDisplayObjects` pool.
 */

const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)

/**
 * @property {import('../ComponentManager/StringManager.js').StringManager} stringManager - The string manager.
 */

export class AssetManager {
	constructor() {
		this.assets = new Map() // Stores PIXI.Texture objects by assetName
		this.assetManifest = new Map() // Stores assetName -> assetPath
		// The pool of managed display objects.
		// Index 0 is intentionally reserved with `null`. This establishes an engine-wide contract
		// that a reference of `0` is invalid or "uninitialized". This is crucial for factory systems
		// (like SpriteFactorySystem) which use `spriteRef: 0` as a sentinel value to detect
		// uninitialized entities, preventing race conditions where the first valid asset ref (0)
		// would collide with the uninitialized state (0).
		this._managedDisplayObjects = [null]
		this._freeDisplayObjectRefs = []

		/**
		 * Direct, public access to the internal storage array for high-performance systems.
		 * @type {PIXI.DisplayObject[]}
		 */
		this.displayObjectStorage = this._managedDisplayObjects
	}

	async init() {
	}

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
	 * Synchronously retrieves an asset from the cache. This is the main method for asset access
	 * and assumes the asset has been preloaded.
	 * @param {string} assetName - A unique name to identify the asset.
	 * @returns {PIXI.Texture | undefined} The texture if found, otherwise undefined.
	 */
	loadAsset(assetName) {
		if (!this.assets.has(assetName)) {
			// Attempt to get it from the PIXI cache, in case it was loaded outside this manager.
			// This is a fallback and the primary path should be preloading via `loadAssetAsync`.
			try {
				const texture = PIXI.Assets.get(assetName);
				if (texture) {
					this.assets.set(assetName, texture);
					return texture;
				}
			}
			catch (e) {
				// PIXI.Assets.get throws if not found
				// This is expected if the asset is not in the cache, so we can ignore the error.
			}

			// Don't warn here, as it's a common case for the caller (like acquireSpriteRefSync) to handle the undefined case.
			return undefined;
		}
		return this.assets.get(assetName);
	}

	/**
	 * Asynchronously loads an asset (e.g., an image) from a given path and stores its texture.
	 * This is the method to use for preloading assets.
	 * @param {string} assetName - A unique name to identify the asset.
	 * @param {string} assetPath - The path to the asset file.
	 * @returns {Promise<boolean>} True if the asset was successfully stored or already existed, false otherwise.
	 */
	async loadAssetAsync(assetName, assetPath = null) {
		if (typeof assetName !== 'string' || !assetName) {
			console.error('AssetManager.loadAsset: assetName must be a non-empty string.')
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
		return this.assets.get(assetName);
	}

	// --- Managed Reference Pattern Methods ---

	/**
	 * Synchronously acquires a sprite from the pool and returns a reference to it.
	 * This method should only be used when the asset is guaranteed to be pre-loaded.
	 * It is the synchronous counterpart to `acquireSpriteRef`.
	 * @param {string} assetName - The name of the pre-loaded asset.
	 * @param {object} [options={}] - Optional properties to apply to the sprite.
	 * @returns {number|null} A reference (`Ref`) to the sprite, or null if the asset is not cached.
	 */
	acquireSpriteRefSync(assetName, options = {}) {
		const texture = this.loadAsset(assetName)
		if (!texture) {
			console.warn(`AssetManager.acquireSpriteRefSync: Asset "${assetName}" not preloaded. Use async acquireSpriteRef instead.`)
			return null
		}

		const sprite = PIXI.Sprite.from(texture)
		const { anchor, ...otherOptions } = options
		Object.assign(sprite, otherOptions)

		if (anchor !== undefined) {
			if (typeof anchor === 'number') {
				sprite.anchor.set(anchor)
			} else if (typeof anchor === 'object' && anchor !== null) {
				sprite.anchor.set(anchor.x ?? 0, anchor.y ?? 0)
			}
		}
		return this.acquireDisplayObjectRef(sprite)
	}

	/**
	 * Acquires a sprite from the pool and returns a reference to it.
	 * This is the preferred method for ECS systems.
	 * @param {string} assetName - The name of the asset to create the sprite from.
	 * @param {object} [options={}] - Optional properties to apply to the sprite.
	 * @returns {Promise<number|null>} A reference (`Ref`) to the sprite in the pool, or null on failure.
	 */
	async acquireSpriteRef(assetName, options = {}) {
		const sprite = await this.createSprite(assetName, options)
		return this.acquireDisplayObjectRef(sprite)
	}

	/**
	 * Adds any PIXI.DisplayObject to the managed pool and returns a reference to it.
	 * This is the generic method for managing any visual object.
	 * @param {PIXI.DisplayObject} displayObject - The object to manage.
	 * @returns {number|null} A reference (`Ref`) to the object in the pool, or null if the object is invalid.
	 */
	acquireDisplayObjectRef(displayObject) {
		if (!displayObject) return null

		if (this._freeDisplayObjectRefs.length > 0) {
			const ref = this._freeDisplayObjectRefs.pop()
			this._managedDisplayObjects[ref] = displayObject
			return ref
		}

		const ref = this._managedDisplayObjects.length
		this._managedDisplayObjects.push(displayObject)
		return ref
	}

	/**
	 * Retrieves a managed display object instance using its reference.
	 * @param {number} ref - The reference ID of the object.
	 * @returns {PIXI.DisplayObject | undefined} The object instance, or undefined if the ref is invalid.
	 */
	getDisplayObjectByRef(ref) {
		return this._managedDisplayObjects[ref]
	}

	/**
	 * Releases a managed sprite back to the pool, making its reference available for reuse.
	 * Also removes the sprite from its parent container and destroys it.
	 * @param {number} ref - The reference ID of the object to release.
	 */
	releaseDisplayObjectRef(ref) {
		if (ref === undefined || ref === null || !this._managedDisplayObjects[ref]) {
			console.warn(`AssetManager.releaseDisplayObjectRef: Invalid or already released ref "${ref}".`)
			return
		}

		const displayObject = this._managedDisplayObjects[ref]

		// The sprite object itself can be reused by PIXI's internal pools if destroyed.
		displayObject.destroy()

		this._managedDisplayObjects[ref] = null
		this._freeDisplayObjectRefs.push(ref)
	}

	// --- User-Friendly / Immediate Mode Methods ---

	/**
	 * Creates a sprite from a loaded asset. This is for immediate, unmanaged use.
	 * For ECS, use `acquireSpriteRef`.
	 * @param {string} assetName - The name of the loaded asset to use.
	 * @param {object} [options={}] - Optional properties to apply to the sprite (e.g., x, y, anchor, scale, tint).
	 *                                `options.anchor` can be a number (for x & y) or an object {x, y}.
	 * @returns {Promise<PIXI.Sprite | null>} The created sprite, or null if the asset is not found or container is invalid.
	 */
	async createSprite(assetName, options = {}) {
		let texture = this.getAsset(assetName)
		if (!texture) {
			const pathForLoading = this.assetManifest.get(assetName)
			if (!pathForLoading) {
				console.error(`AssetManager.createSprite: No path found for asset "${assetName}" in manifest.`)
				return null
			}
			const loaded = await this.loadAssetAsync(assetName, pathForLoading) // loadAsset will use manifest if path not given
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
