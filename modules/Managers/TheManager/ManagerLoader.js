/**
 * Dynamically loads all manager instances by fetching the manager tree from the main process.
 * It constructs the path to the main manager file (ManagerName/ManagerName.js),
 * imports it, and extracts the exported instance (e.g., componentManager).
 * This function loads managers sequentially, consistent with ModuleLoader.js.
 *
 * @returns {Promise<Map<string, object>>} A promise that resolves to a map where keys
 *   are manager class names (e.g., 'ComponentManager') and values are the
 *   manager instances.
 */
export async function loadAllManagers() {
	const managerTree = await window.electronAPI.getManagerTree()
	const loadedManagers = new Map()

	for (const managerClassName in managerTree) {
		// The main file for a manager is assumed to have the same name as its folder/class.
		if (managerTree[managerClassName].includes(managerClassName)) {
			const path = `${PATH_MANAGERS}/${managerClassName}/${managerClassName}.js`
			const instanceName = managerClassName.charAt(0).toLowerCase() + managerClassName.slice(1)
			try {
				const module = await import(path)
				const instance = module[instanceName]

				if (instance) {
					loadedManagers.set(managerClassName, instance)
				} else {
					console.error(`ManagerLoader: Could not find exported instance '${instanceName}' in ${path}.`)
				}
			} catch (error) {
				console.error(`ManagerLoader: Failed to load manager ${managerClassName} from ${path}:`, error)
			}
		}
	}
	return loadedManagers
}
