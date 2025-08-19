/**
 * @fileoverview Provides a utility for dynamically loading component modules.
 */

/**
 * Dynamically loads component modules by fetching the component tree from the main process
 * and then importing them. This utility is used by the ComponentManager to load all available components.
 * @returns {Promise<Map<string, object>>} A promise that resolves to a map where keys are module names
 *   and values are the imported module namespaces.
 */
export async function loadAllComponents() {
	const componentTree = await window.electronAPI.getComponentTree()

	const loadedModules = []

	for (const category in componentTree) {
		for (const moduleName of componentTree[category]) {
			try {
				const modulePath = `${PATH_COMPONENTS}/${category}/${moduleName}.js`
				const module = await import(modulePath)
				loadedModules.push({ moduleName, module, category })
			} catch (error) {
				console.error(`ComponentLoader: Failed to load component '${moduleName}':`, error)
			}
		}
	}
	return loadedModules
}