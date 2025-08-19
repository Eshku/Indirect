/**
 * @fileoverview Provides a utility for dynamically loading system modules.
 */

/**
 * Dynamically loads system modules by fetching the system tree from the main process
 * and then importing them.
 * This utility is used by the SystemManager to load all available systems.
 * @returns {Promise<Map<string, object>>} A promise that resolves to a map where keys are system names
 *   and values are the imported module namespaces.
 */
export async function loadAllSystems() {
	const systemTree = await window.electronAPI.getSystemTree()
	const loadedModules = new Map()

	for (const category in systemTree) {
		for (const moduleName of systemTree[category]) {
			try {
				const modulePath = `${PATH_SYSTEMS}/${category}/${moduleName}.js`
				const module = await import(modulePath)
				loadedModules.set(moduleName, module)
			} catch (error) {
				console.error(`SystemLoader: Failed to load system '${moduleName}':`, error)
			}
		}
	}
	return loadedModules
}