const { LRUCache } = await import(`${PATH_CORE}/DataStructures/LRUCache.js`)

const { parsePrefab } = await import(`${PATH_MANAGERS}/PrefabManager/PrefabParser.js`)
const { PrefabLoader } = await import(`${PATH_MANAGERS}/PrefabManager/PrefabLoader.js`)

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
 * #### The `prefabId`
 *
 * The `prefabId` is a simple, human-readable, unique string (e.g., `"obsidian_sword"`, `"goblin_shaman"`)
 * that serves as the universal key for any prefab. This ID is what you use in game logic, such as in console
 * commands (`spawn obsidian_sword`) or in other prefabs (`"projectilePrefab": "fireball_projectile"`).
 *
 * #### How it Works
 *
 * 1.  **Manifest:** The manifest maps each `prefabId` to its source data file (`.json`).
 * 2.  **Decoupling:** This completely decouples the game logic from the file system structure. You can reorganize your asset folders, and you only need to update the manifest, not your game code.
 * 3.  **Flexibility & Modding:** This design is incredibly powerful for modding. A mod can introduce new items, characters, or effects simply by providing its own manifest file that the engine loads and merges. It also makes creating developer tools (like a level editor with a dropdown of spawnable objects) trivial.


 */
export class PrefabManager {
	constructor({ cacheSize = 100 } = {}) {
		// Cache for instance component templates.
		this.instanceDataCache = new LRUCache(cacheSize)
		// Cache for shared, static data.
		this.sharedDataCache = new LRUCache(cacheSize)
		// Cache for raw data from files to avoid repeated IPC calls.
		this.rawPrefabData = new LRUCache(cacheSize)
		// Cache for parsed child entity definitions.
		this.childrenCache = new LRUCache(cacheSize)

		/**
		 * @property {PrefabLoader} loader - Handles the I/O and loading logic.
		 */
		this.loader = new PrefabLoader(this)

		/**
		 * @property {Map<string, object>} manifest - Stores the entire prefab manifest. Maps prefabId -> manifest entry.
		 */
		this.manifest = new Map()
	}

	async init() {
		await this.loader.loadManifest()
	}
	/**
	 * Pre-loads a list of prefabs into the cache. This is intended to be called
	 * during a loading screen or setup phase to ensure critical assets are
	 * available for synchronous creation later.
	 * @param {string[]} [prefabIds=[]] - An array of prefab IDs from the manifest to load.
	 * @returns {Promise<void>}
	 */
	async preload(prefabIds = []) {
		const loadPromises = prefabIds.map(prefabId => this.loader.preload(prefabId))
		await Promise.allSettled(loadPromises)
	}

	/**
	 * Synchronously retrieves fully resolved prefab data from the cache.
	 * This method does NOT perform file I/O and will only return data that
	 * has been pre-loaded. It is used for the high-performance creation path.
	 * @param {string} prefabId - The ID of the prefab from the manifest.
	 * @returns {{components: object, shared: object, children: object[]} | null} The cached data or null if not found.
	 */
	getPrefabDataSync(prefabId) {
		const manifestEntry = this.manifest.get(prefabId)
		if (!manifestEntry) return null

		const canonicalName = manifestEntry.path.toLowerCase()
		const components = this.instanceDataCache.get(canonicalName)
		if (!components) {
			return null // Not in cache, cannot be retrieved synchronously.
		}
		const shared = this.sharedDataCache.get(canonicalName) || {}
		const children = this.childrenCache.get(canonicalName) || []
		return { components, shared, children }
	}

	/**
	 * Synchronously retrieves the instance component template from the cache.
	 * @param {string} prefabName - The name of the prefab.
	 * @returns {object|null} The cached component template or null if not found.
	 */
	getComponents(prefabName) {
		const manifestEntry = this.manifest.get(prefabName)
		if (!manifestEntry) return null

		const canonicalPath = manifestEntry.path.toLowerCase()
		return this.instanceDataCache.get(canonicalPath)
	}

	/**
	 * Synchronously retrieves the shared data from the cache.
	 * @param {string} prefabName - The name of the prefab.
	 * @returns {object|null} The cached shared data or null if not found.
	 */
	getShared(prefabName) {
		const manifestEntry = this.manifest.get(prefabName)
		if (!manifestEntry) return null

		const canonicalPath = manifestEntry.path.toLowerCase()
		return this.sharedDataCache.get(canonicalPath)
	}

	/**
	 * Retrieves the fully resolved prefab data, separating it into instance components
	 * and shared data. This method handles multi-level inheritance.
	 * @param {string} prefabName - The name of the prefab (e.g., 'Items/Skills/Fireball').
	 * @param {Set<string>} [visited=new Set()] - Used internally to detect circular dependencies.
	 * @returns {Promise<{components: object, shared: object, children: object[]}|null>} The resolved prefab data or null if not found.
	 */
	async getPrefabData(prefabId, visited = new Set()) {
		if (!prefabId) {
			console.error(`PrefabManager: getPrefabData called with invalid prefabId: ${prefabId}`)
			return null
		}

		const manifestEntry = this.manifest.get(prefabId)
		if (!manifestEntry) {
			console.error(
				`PrefabManager: Could not find data prefab with ID '${prefabId}' in manifest. Ensure 'extends' properties use manifest IDs, not paths.`
			)
			return null
		}
		const prefabPath = manifestEntry.path
		const canonicalName = prefabPath.toLowerCase()

		// 1. Circular dependency check
		if (visited.has(prefabId)) {
			console.error(`Circular prefab dependency detected: ${[...visited, prefabId].join(' -> ')}`)
			return null // Abort to prevent infinite recursion
		}
		visited.add(prefabId)

		// Check cache for final, merged data first.
		// We only need to check one cache; if it exists, the other will too.
		const cachedInstanceData = this.instanceDataCache.get(canonicalName)
		if (cachedInstanceData) {
			return {
				components: cachedInstanceData,
				shared: this.sharedDataCache.get(canonicalName) || {},
				children: this.childrenCache.get(canonicalName) || [],
			}
		}

		// Check cache for raw data. If not present, load it via IPC.
		let rawData = this.rawPrefabData.get(canonicalName)
		if (!rawData) rawData = await this.loader.loadAndCacheRawData(prefabPath)
		if (!rawData) return null // Error already logged by _loadAndCacheRawData

		// 2. Explicit Dependency Preloading
		// Pre-load any explicit dependencies so they are available in the cache for other systems (e.g., tooltips).
		if (rawData.dependencies && Array.isArray(rawData.dependencies)) {
			const dependencyPromises = rawData.dependencies.map(depId => {
				// Avoid re-adding to the current visited set if it's already there.
				if (!visited.has(depId)) {
					// Pass a *copy* of the visited set to avoid sibling dependencies polluting each other's paths.
					return this.getPrefabData(depId, new Set(visited))
				}
				return Promise.resolve()
			})
			await Promise.all(dependencyPromises)
		}

		let baseComponents = {}
		let baseShared = {}
		let baseChildren = []
		if (rawData.extends) {
			const extendNames = Array.isArray(rawData.extends) ? rawData.extends : [rawData.extends]

			for (const extendName of extendNames) {
				// Recursively get the base prefab data, passing a *copy* of the visited set.
				const basePrefabData = await this.getPrefabData(extendName, new Set(visited))
				if (basePrefabData) {
					// Deep merge components and shared data from each base.
					// The order matters: later extensions override earlier ones.
					if (basePrefabData.components) {
						baseComponents = this._deepMerge(baseComponents, basePrefabData.components)
					}
					if (basePrefabData.shared) {
						baseShared = this._deepMerge(baseShared, basePrefabData.shared)
					}
					if (basePrefabData.children) {
						baseChildren = [...baseChildren, ...basePrefabData.children]
					}
				} else {
					// This is a non-critical failure, as the base prefab might be optional or misspelled.
					console.warn(`PrefabManager: Could not resolve extended prefab '${extendName}' for prefab '${prefabId}'.`)
				}
			}
		}

		const mergedComponents = this._deepMerge(baseComponents, rawData.components || {})
		const finalShared = this._deepMerge(baseShared, rawData.shared || {})

		// --- Recursively resolve children with 'extends' and combine with base children ---
		const resolvedOwnChildren = await this._resolveChildren(rawData.children || [], new Set(visited))
		const finalChildren = [...baseChildren, ...resolvedOwnChildren]
		parsePrefab(finalChildren) // The parser now mutates the array in-place to resolve enums

		this.instanceDataCache.set(canonicalName, mergedComponents)
		this.sharedDataCache.set(canonicalName, finalShared)
		this.childrenCache.set(canonicalName, finalChildren)

		return { components: mergedComponents, shared: finalShared, children: finalChildren }
	}

	/**
	 * Recursively resolves `extends` within an array of child entity definitions.
	 * This allows for prefab inheritance at any level of the entity hierarchy.
	 * @param {object[]} children - The array of child entity definitions.
	 * @param {Set<string>} visited - Used to detect circular dependencies in prefab inheritance.
	 * @returns {Promise<object[]>} The resolved array of child definitions.
	 * @private
	 */
	async _resolveChildren(children, visited) {
		if (!children || !Array.isArray(children)) {
			return []
		}

		const resolvedChildren = []
		for (const childDef of children) {
			let currentChild = { ...childDef }
			let prefabIdForChild = null

			if (currentChild.extends) {
				prefabIdForChild = currentChild.extends
				const basePrefabData = await this.getPrefabData(currentChild.extends, new Set(visited))

				if (basePrefabData) {
					// The base prefab data is the foundation.
					// The child definition in the parent prefab acts as a set of overrides.
					// _deepMerge will handle merging 'components', 'shared', and 'children' arrays correctly.
					const mergedChild = this._deepMerge(basePrefabData, currentChild)
					delete mergedChild.extends // Clean up the extends property after merging
					currentChild = mergedChild
				} else {
					console.warn(`PrefabManager: Could not resolve extended child prefab '${childDef.extends}'.`)
					delete currentChild.extends
				}
			}

			// If the child was extended, we should ensure it has a PrefabId component
			// pointing to the prefab it was extended from. This is crucial for systems
			// that need to identify the type of a child entity (e.g., for cooldowns).
			if (prefabIdForChild) {
				currentChild.components = currentChild.components || {}
				if (!currentChild.components.PrefabId) {
					currentChild.components.PrefabId = { id: prefabIdForChild }
				}
			}

			// Now, recursively resolve the children of this newly merged child definition.
			if (currentChild.children) {
				currentChild.children = await this._resolveChildren(currentChild.children, new Set(visited))
			}

			resolvedChildren.push(currentChild)
		}
		return resolvedChildren
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
				} else if (Array.isArray(source[key]) && key in target && Array.isArray(target[key])) {
					// Custom array merging logic for arrays of objects with a 'key'
					output[key] = this._mergeArrayByKey(target[key], source[key])
				} else {
					// Default behavior: source property overwrites target property
					output[key] = source[key]
				}
			})
		}
		return output
	}

	/**
	 * Merges two arrays of objects, using a `key` property to identify objects for merging.
	 * If an object in `sourceArray` has a key that exists in `targetArray`, the objects are deep-merged.
	 * If the key does not exist, the object is added to the array. This preserves the order of the target array
	 * and appends new, non-keyed, or un-matched-key items from the source array.
	 * @param {object[]} targetArray - The base array.
	 * @param {object[]} sourceArray - The array with overrides/additions.
	 * @returns {object[]} The merged array.
	 * @private
	 */
	_mergeArrayByKey(targetArray, sourceArray) {
		const sourceMap = new Map(sourceArray.filter(item => item && item.key).map(item => [item.key, item]))
		const merged = []
		const processedSourceKeys = new Set()

		// Iterate through target array to merge with matching source items
		targetArray.forEach(targetItem => {
			const key = targetItem && targetItem.key
			if (key && sourceMap.has(key)) {
				merged.push(this._deepMerge(targetItem, sourceMap.get(key)))
				processedSourceKeys.add(key)
			} else {
				merged.push(targetItem)
			}
		})

		// Add new items from source array that were not used for merging
		sourceArray.forEach(sourceItem => {
			const key = sourceItem && sourceItem.key
			if (!key || !processedSourceKeys.has(key)) {
				merged.push(sourceItem)
			}
		})

		return merged
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
