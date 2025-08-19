/**
 * @fileoverview Handles the I/O and loading logic for the PrefabManager.
 * This class is responsible for loading the prefab manifest and for pre-loading data-driven
 * prefabs from the filesystem.
 */
export class PrefabLoader {
	/**
	 * @param {import('./PrefabManager.js').PrefabManager} prefabManager - A reference to the parent manager for accessing its caches and manifest.
	 */
	constructor(prefabManager) {
		this.manager = prefabManager
	}

	/**
	 * Loads and parses the main prefab manifest file.
	 */
	async loadManifest() {
		const manifestData = await window.electronAPI.getPrefabManifest()
		if (manifestData) {
			this.manager.manifest = new Map(Object.entries(manifestData))
		} else {
			console.error('PrefabManager: Failed to load prefab manifest.')
			this.manager.manifest = new Map()
		}
	}

	/**
	 * Preloads a single prefab based on its manifest entry.
	 * @param {string} prefabId - The manifest ID of the prefab to load.
	 */
	async preload(prefabId) {
		const manifestEntry = this.manager.manifest.get(prefabId)
		if (!manifestEntry) {
			console.error(`PrefabManager: Cannot preload '${prefabId}'. Not found in manifest.`)
			return
		}

		// The only thing to do is load data.
		await this.manager.getPrefabData(prefabId)
	}

	async loadAndCacheRawData(prefabPath) {
		const canonicalName = prefabPath.toLowerCase()
		const rawData = await window.electronAPI.getPrefabData(prefabPath)
		if (!rawData) {
			console.error(
				`PrefabManager: Failed to load prefab data for '${prefabPath}'. The file might be missing or invalid.`
			)
			return null
		}
		this.manager.rawPrefabData.set(canonicalName, rawData)
		return rawData
	}
}
