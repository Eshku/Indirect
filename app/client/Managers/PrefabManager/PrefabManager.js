const { LRUCache } = await import(`${PATH_CORE}/DataStructures/LRUCache.js`)

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
		// --- Permanent Caches for Prefab Templates ---
		// These store the canonical, processed data for prefabs defined in files.
		// They are now stored in arrays, indexed by a numeric prefab ID for O(1) access.
		this.processedPrefabCache = []
		this.processedChildrenCache = []
		// Cache for raw data from files to avoid repeated file system access.
		this.rawPrefabDataCache = new Map()

		/**
		 * @property {LRUCache} variantCache - An LRU cache for storing runtime-generated prefab variants.
		 * This is for entities that are based on a prefab but have been modified at runtime (e.g., a sword with unique stats).
		 * Using an LRU cache here prevents memory leaks from accumulating countless unique entity variations.
		 */
		this.variantCache = new LRUCache(cacheSize)

		/**
		 * @property {PrefabLoader} loader - Handles the I/O and loading logic.
		 */
		this.loader = new PrefabLoader(this)

		/**
		 * @property {Map<string, object>} manifest - Stores the entire prefab manifest. Maps prefabId -> manifest entry.
		 */
		this.manifest = new Map()
		/**
		 * @property {Map<string, number>} prefabIdToNumericId - Maps string prefabId to a numeric ID for fast lookups.
		 */
		this.prefabIdToNumericId = new Map()
		/**
		 * @property {object[]} numericIdToManifestEntry - Maps a numeric ID back to its manifest entry.
		 */
		this.numericIdToManifestEntry = []

		/**
		 * @property {ComponentManager} componentManager - A reference to the component manager for schema lookups.
		 * This is populated during the init phase.
		 */
		this.componentManager = null
	}

	async init() {
		this.componentManager = (await import(`${PATH_MANAGERS}/ComponentManager/ComponentManager.js`)).componentManager
		await this.loader.loadManifest()
		let currentId = 0
		for (const [prefabId, manifestEntry] of this.manifest.entries()) {
			this.prefabIdToNumericId.set(prefabId, currentId)
			this.numericIdToManifestEntry[currentId] = manifestEntry
			// Attach the numeric ID to the manifest entry for convenience
			manifestEntry.numericId = currentId
			currentId++
		}
	}
	/**
	 * Pre-loads a list of prefabs into the cache. This is intended to be called
	 * during a loading screen or setup phase to ensure critical assets are
	 * available for synchronous creation later.
	 * @param {string[]} [prefabIds=[]] - An array of prefab IDs from the manifest to load.
	 * @returns {Promise<void>}
	 */
	async preload(prefabIds = []) {
		const loadPromises = prefabIds.map(prefabId => this._processPrefabData(prefabId))
		await Promise.allSettled(loadPromises)
	}

	/**
	 * Synchronously retrieves fully resolved prefab data from the cache.
	 * This method does NOT perform file I/O and will only return data that
	 * has been pre-loaded. It is used for the high-performance creation path.
	 * @param {string} prefabId - The ID of the prefab from the manifest.
	 * @returns {{components: object, children: object[]} | null} The cached data or null if not found.
	 */
	getPrefabData(prefabId) {
		const numericId = this.getPrefabNumericId(prefabId)
		if (numericId === undefined) {
			// This can be a valid case for external callers, so we don't error, just return null.
			return null
		}
		return this.getPrefabDataByNumericId(numericId)
	}

	/**
	 * Gets the numeric ID for a given string-based prefab ID.
	 * @param {string} prefabId
	 * @returns {number | undefined}
	 */
	getPrefabNumericId(prefabId) {
		return this.prefabIdToNumericId.get(prefabId)
	}

	/**
	 * The new internal, high-performance way to get prefab data, used by the CommandBufferExecutor.
	 * @param {number} numericId The numeric ID of the prefab.
	 * @returns {{components: object, children: object[]} | null}
	 */
	getPrefabDataByNumericId(numericId) {
		const components = this.processedPrefabCache[numericId]
		if (components === undefined) {
			console.error(
				`PrefabManager: Prefab with numericId '${numericId}' was not preloaded. Use preload() during setup.`
			)
			return null
		}
		return { components, children: this.processedChildrenCache[numericId] || [] }
	}

	/**
	 * Asynchronously loads and processes prefab data from the file system, handling inheritance and caching the final result.
	 * This is intended to be used during a loading phase.
	 * @param {string} prefabId - The name of the prefab (e.g., 'Items/Skills/Fireball').
	 * @param {Set<string>} [visited=new Set()] - Used internally to detect circular dependencies.
	 * @returns {Promise<{components: object, children: object[]}|null>} The resolved prefab data or null if not found.
	 * @private
	 */
	async _processPrefabData(prefabId, visited = new Set()) {
		if (!prefabId) {
			console.error(`PrefabManager: getPrefabData called with invalid prefabId: ${prefabId}`)
			return null
		}

		const numericId = this.prefabIdToNumericId.get(prefabId)
		if (numericId === undefined) {
			console.error(`PrefabManager: Could not find prefab with ID '${prefabId}' in manifest.`)
			return null
		}

		// Check cache for final, merged data first.
		const cachedComponents = this.processedPrefabCache[numericId]
		if (cachedComponents) {
			return {
				components: cachedComponents,
				children: this.processedChildrenCache[numericId] || [],
			}
		}

		if (visited.has(prefabId)) {
			console.error(`Circular prefab dependency detected: ${[...visited, prefabId].join(' -> ')}`)
			return null // Abort to prevent infinite recursion
		}
		visited.add(prefabId)

		const manifestEntry = this.numericIdToManifestEntry[numericId]
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
		let baseChildren = []
		if (rawData.extends) {
			const extendNames = Array.isArray(rawData.extends) ? rawData.extends : [rawData.extends]

			for (const extendName of extendNames) {
				const basePrefabData = await this._processPrefabData(extendName, new Set(visited))
				if (basePrefabData) {
					if (basePrefabData.components) {
						baseComponents = this._deepMerge(baseComponents, basePrefabData.components)
					}
					if (basePrefabData.children) {
						baseChildren = [...baseChildren, ...basePrefabData.children]
					}
				} else {
					console.warn(`PrefabManager: Could not resolve extended prefab '${extendName}' for prefab '${prefabId}'.`)
				}
			}
		}

		// Process shorthand notations (e.g., "range": 500) into their full object form.
		const processedOwnComponents = this._processShorthands(rawData.components || {}, prefabId)

		const mergedComponents = this._deepMerge(baseComponents, processedOwnComponents)

		const resolvedOwnChildren = await this._resolveChildren(rawData.children || [], new Set(visited))
		const finalChildren = [...baseChildren, ...resolvedOwnChildren]

		const processedComponents = mergedComponents

		this.processedPrefabCache[numericId] = processedComponents
		this.processedChildrenCache[numericId] = finalChildren

		return { components: processedComponents, children: finalChildren }
	}

	/**
	 * Processes a component data object, expanding any shorthand notations into their full object form.
	 * For example, it converts `"range": 500` into `"range": { "value": 500 }`.
	 * @param {object} components - The components object from a raw prefab file.
	 * @param {string} prefabId - The ID of the prefab being processed, for error logging.
	 * @returns {object} A new components object with all shorthands expanded.
	 * @private
	 */
	_processShorthands(components, prefabId) {
		if (!this.componentManager) {
			console.error('PrefabManager: componentManager reference is missing. Cannot process shorthands.')
			return components // Return original data if manager is not set
		}

		const processedComponents = {}
		for (const componentName in components) {
			const componentData = components[componentName]
			const dataType = typeof componentData

			// If the component's data is a primitive (not an object), it's a potential shorthand.
			if (dataType === 'number' || dataType === 'string' || dataType === 'boolean') {
				const info = this.componentManager.componentInfo[this.componentManager.getComponentTypeIDByName(componentName)]

				if (info && info.originalSchemaKeys && info.originalSchemaKeys.length > 0) {
					// --- Universal Shorthand Rule ---
					// The shorthand value is always applied to the *first* property defined in the component's schema.
					// This covers both the unambiguous case (one property) and the ambiguous case (multiple properties).
					//
					// DEVELOPER NOTE: This creates a dependency on the order of properties in the component's
					// static schema. The property intended for shorthand use MUST be listed first.
					// e.g., For `Stack: 64`, the schema must be `{ size: 'u16', amount: 'u16' }`, not the other way around.

					//We could've went with more strict approach, where shorthands are only allowed for
					//components with single property, but in some cases for prefab definitions only one matters
					//and the other one is defined at runtime through overrides
					//example - stack. On prefab it only makes sense to define capacity
					//but amount is runtime-only thing - how many items dropped from the thing.
					const key = info.originalSchemaKeys[0]
					processedComponents[componentName] = { [key]: componentData }
					continue // Move to the next component
				}

				// If we're here, we couldn't resolve the shorthand because the component has no schema properties.
				// This is a critical data error. We will log a detailed error and skip this component entirely,
				// rather than assigning a default or empty value, to ensure the error is noticed and fixed at the source.
				console.error(
					`PrefabManager: Invalid shorthand for component "${componentName}" in prefab "${prefabId}". Components with no schema are treated as "Tag Components" and cannot have data.`
				)
			} else {
				// The component data is already in its full object form, so we keep it as is.
				processedComponents[componentName] = componentData
			}
		}
		return processedComponents
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
				const basePrefabData = await this._processPrefabData(currentChild.extends, new Set(visited))

				if (basePrefabData) {
					// The base prefab data is the foundation.
					// The child definition in the parent prefab acts as a set of overrides.
					// _deepMerge will handle merging 'components' and 'children' arrays correctly.
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

			// If the child has a `key`, automatically add a `PrefabChildKey` component
			// to it. This is crucial for relational lookups by systems like the TooltipSystem.
			if (currentChild.key) {
				currentChild.components = currentChild.components || {}
				if (!currentChild.components.PrefabChildKey) {
					currentChild.components.PrefabChildKey = { key: currentChild.key }
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
