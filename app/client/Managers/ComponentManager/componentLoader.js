/**
 * Provides a utility for dynamically loading component modules.
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
				const modulePath = `@components/${category}/${moduleName}.js`
				const module = await import(modulePath)
				//  component definition is now expected to be the main export,
				// or an export with the same name as the module.
				const componentSchema = module.default || module[moduleName]
				if (componentSchema && typeof componentSchema === 'object') {
					// Pass the schema directly, not the whole module object.
					loadedModules.push({ moduleName, componentSchema, category })
				} else {
					console.error(
						`ComponentLoader: Could not find a valid component schema export in module "${moduleName}". Looked for 'default' or an export named '${moduleName}'.`,
					)
				}
			} catch (error) {
				console.error(`ComponentLoader: Failed to load component '${moduleName}':`, error)
			}
		}
	}
	return loadedModules
}
