const { LRUCache } = await import(`@core/DataStructures/LRUCache.js`)
const { resolveComponentData } = await import(`@managers/ComponentManager/ComponentInterpreter.js`)
const { Schema } = await import(`@managers/ComponentManager/ComponentSchema.js`)

const { PrefabLoader } = await import(`@managers/PrefabManager/PrefabLoader.js`)

/**
 * Manages prefab definitions, which serve as templates for creating entities.
 * This manager is central to the engine's data-driven and mod-friendly architecture.
 *
 * ---
 *
 * ### The Manifest-Driven Architecture
 *
 * Instead of referencing prefabs by their file paths, the engine uses a **manifest-driven** approach.
 * A central `prefabs.manifest.json` file acts as a "phone book" for all spawnable entities in the game.
 *
 * #### The `prefabName`
 *
 * The `prefabName` is a simple, human-readable, unique string (e.g., `"obsidian_sword"`, `"goblin_shaman"`)
 * that serves as the universal key for any prefab. This name is what you use in game logic, such as in console
 * commands (`spawn obsidian_sword`) or in other prefabs (`"projectilePrefab": "fireball_projectile"`).
 *
 * #### How it Works
 *
 * 1.  **Manifest:** The manifest maps each `prefabName` to its source data file (`.json`).
 * 2.  **Decoupling:** This completely decouples the game logic from the file system structure. You can reorganize your asset folders, and you only need to update the manifest, not your game code.
 * 3.  **Flexibility & Modding:** This design is incredibly powerful for modding. A mod can introduce new items, characters, or effects simply by providing its own manifest file that the engine loads and merges. It also makes creating developer tools (like a level editor with a dropdown of spawnable objects) trivial.

 * ---
 * ### TODO: Dynamic Prefab Registration
 * A potential future feature is to allow dynamic registration of prefabs at runtime via a
 * `prefabManager.registerPrefab(name, data, [saveToDisc])` method. This would be highly beneficial for:
 * - Unit testing (to avoid file I/O).
 * - Procedurally generated content.
 * - Live-editing tools.
 * A robust implementation would need to handle ID assignment, potential name collisions,
 * and re-processing of dependent prefabs if the new prefab is an `extends` target.
 * This is not a current priority but is a valuable architectural consideration.
 * ---


 */

export class PrefabManager {
	constructor() {
		// --- Permanent Caches for Prefab Templates ---
		// These store the canonical, processed data for prefabs defined in files.
		// They are now stored in arrays, indexed by a numeric prefab ID for O(1) access.
		this.processedPrefabCache = [] // This now stores the final component data object.
		// Cache for raw data from files to avoid repeated file system access.
		this.rawPrefabDataCache = new Map()

		/**
		 * @property {PrefabLoader} loader - Handles the I/O and loading logic.
		 */
		this.loader = new PrefabLoader(this)

		/**
		 * @property {Map<string, object>} manifest - Stores the entire prefab manifest. Maps prefabName -> manifest entry.
		 */
		this.manifest = new Map()
		/**
		 * @property {Map<string, number>} prefabNameToId - Maps string prefabName to a numeric ID for fast lookups.
		 */
		this.prefabNameToId = new Map()
		/**
		 * @property {object[]} prefabIdToManifestEntry - Maps a numeric ID back to its manifest entry.
		 */
		this.prefabIdToManifestEntry = []
		/**
		 * @property {string[]} idToPrefabName - Maps a numeric ID back to its string name.
		 */
		this.idToPrefabName = []

		/**
		 * @property {ComponentManager} componentManager - A reference to the component manager for schema lookups.
		 * This is populated during the init phase.
		 */
		this.componentManager = null
	}

	async init(ecs) {
		// This manager is now owned by ECS, so it gets its dependencies from there.
		this.componentManager = ecs.componentManager
		await this.loader.loadManifest()

		let currentId = 0
		for (const [prefabName, manifestEntry] of this.manifest.entries()) {
			this.prefabNameToId.set(prefabName, currentId)
			this.prefabIdToManifestEntry[currentId] = manifestEntry
			this.idToPrefabName[currentId] = prefabName
			// Attach the numeric ID to the manifest entry for convenience
			manifestEntry.id = currentId
			currentId++
		}
	}
	/**
	 * Pre-loads a list of prefabs into the cache. This is intended to be called
	 * during a loading screen or setup phase to ensure critical assets are
	 * available for synchronous creation later.
	 * @param {string[]} [prefabNames=[]] - An array of prefab names from the manifest to load.
	 * @returns {Promise<void>}
	 */
	async preload(prefabNames = []) {
		const loadPromises = prefabNames.map(prefabName => this._processPrefabData(prefabName))
		await Promise.allSettled(loadPromises)
	}

	/**
	 * Synchronously retrieves fully resolved prefab data from the cache.
	 * This method does NOT perform file I/O and will only return data that
	 * has been pre-loaded. It is used for the high-performance creation path.
	 * @param {string} prefabName - The name of the prefab from the manifest.
	 * @returns {object | null} The cached component data object or null if not found.
	 */
	getPrefabData(prefabName) {
		const id = this.getPrefabId(prefabName)
		if (id === undefined) {
			// This can be a valid case for external callers, so we don't error, just return null
			return null
		}
		return this.getPrefabDataById(id)
	}

	/**
	 * Gets the numeric ID for a given prefab name.
	 * @param {string} prefabName
	 * @returns {number | undefined}
	 */
	getPrefabId(prefabName) {
		return this.prefabNameToId.get(prefabName)
	}

	/**
	 * Gets the string name for a given numeric prefab ID.
	 * @param {number} id
	 * @returns {string | undefined}
	 */
	getPrefabNameById(id) {
		return this.idToPrefabName[id]
	}

	getPrefabDataById(id) {
		const components = this.processedPrefabCache[id]
		if (components === undefined) {
			console.error(`PrefabManager: Prefab with id '${id}' was not preloaded. Use preload() during setup.`)
			return null // Return null to indicate the prefab data is not available.
		}
		return components
	}

	/**
	 * Asynchronously loads and processes prefab data from the file system, handling inheritance and caching the final result.
	 * This is intended to be used during a loading phase.
	 * @param {string} prefabName - The name of the prefab (e.g., 'Items/Skills/Fireball').
	 * @param {Set<string>} [visited=new Set()] - Used internally to detect circular dependencies.
	 * @returns {Promise<object|null>} The resolved component data object or null if not found.
	 * @private
	 */
	async _processPrefabData(prefabName, visited = new Set()) {
		if (!prefabName) {
			console.error(`PrefabManager: getPrefabData called with invalid prefabName: ${prefabName}`)
			return null
		}

		const id = this.prefabNameToId.get(prefabName)
		if (id === undefined) {
			console.error(`PrefabManager: Could not find prefab with ID '${prefabName}' in manifest.`)
			return null
		}

		// Check cache for final, merged data first.
		const cachedComponents = this.processedPrefabCache[id]
		if (cachedComponents) {
			return cachedComponents
		}

		if (visited.has(prefabName)) {
			console.error(`Circular prefab dependency detected: ${[...visited, prefabName].join(' -> ')}`)
			return null // Abort to prevent infinite recursion
		}
		visited.add(prefabName)

		const manifestEntry = this.prefabIdToManifestEntry[id]
		const prefabPath = manifestEntry.path
		const canonicalPath = prefabPath.toLowerCase()
		// Check cache for raw data. If not present, load it via IPC.
		let rawData = this.rawPrefabDataCache.get(canonicalPath)
		if (!rawData) rawData = await this.loader.loadAndCacheRawData(prefabPath)
		if (!rawData) return null // Error already logged by _loadAndCacheRawData

		// 2. Explicit Dependency Preloading
		if (rawData.dependencies && Array.isArray(rawData.dependencies)) {
			const dependencyPromises = rawData.dependencies.map(depId => {
				if (!visited.has(depId)) {
					return this._processPrefabData(depId, new Set(visited))
				}
				return Promise.resolve()
			})
			await Promise.all(dependencyPromises)
		}

		let baseComponents = {}
		if (rawData.extends) {
			const extendNames = Array.isArray(rawData.extends) ? rawData.extends : [rawData.extends]

			for (const extendName of extendNames) {
				const basePrefabData = await this._processPrefabData(extendName, new Set(visited))
				if (basePrefabData) {
					baseComponents = this._deepMerge(baseComponents, basePrefabData)
				} else {
					console.warn(`PrefabManager: Could not resolve extended prefab '${extendName}' for prefab '${prefabName}'.`)
				}
			}
		}

		// Resolve shorthands and apply defaults to the prefab's own components.
		const processedOwnComponents = this._resolveComponents(rawData.components || {}, prefabName)

		const mergedComponents = this._deepMerge(baseComponents, processedOwnComponents)

		this.processedPrefabCache[id] = mergedComponents

		return mergedComponents
	}

	/**
	 * Resolves a raw components object from a prefab file by expanding shorthands and applying defaults for each component.
	 * @param {object} components - The components object from a raw prefab file.
	 * @param {string} prefabName - The name of the prefab being processed, for error logging.
	 * @returns {object} A new components object with all component data fully resolved to its high-level object form.
	 * @private
	 */
	_resolveComponents(components, prefabName) {
		if (!this.componentManager) {
			console.error('PrefabManager: componentManager reference is missing. Cannot resolve components.')
			return components // Return original data if manager is not set
		}

		const processedComponents = {}
		for (const componentName in components) {
			const componentData = components[componentName]
			const typeID = this.componentManager.getComponentTypeIDByName(componentName)

			if (typeID !== undefined) {
				// Use the new shared resolver function.
				processedComponents[componentName] = resolveComponentData(typeID, componentData)
			} else {
				// If the component is not found in the schema, keep its data as-is.
				// This allows for mod-added components or potential data-only components without schemas.
				processedComponents[componentName] = componentData
			}
		}
		return processedComponents
	}

	/**
	 * Deeply merges source object into target object without mutating the target.
	 * @param {object} target - The target object.
	 * @param {object} source - The source object.
	 * @returns {object} The merged object.
	 * @private
	 */
	_deepMerge(target, source) {
		const output = { ...target }
		if (this._isObject(target) && this._isObject(source)) {
			Object.keys(source).forEach(key => {
				if (this._isObject(source[key]) && key in target && this._isObject(target[key])) {
					// Recursive merge for nested objects
					output[key] = this._deepMerge(target[key], source[key])
				} else {
					// Default behavior: source property overwrites target property
					output[key] = source[key]
				}
			})
		}
		return output
	}

	/**
	 * Helper to check if an item is a non-array object.
	 * @param {*} item
	 * @returns {boolean}
	 * @private
	 */
	_isObject(item) {
		return item && typeof item === 'object' && !Array.isArray(item)
	}
}

export const prefabManager = new PrefabManager()
