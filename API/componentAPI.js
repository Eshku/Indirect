const { ipcMain } = require('electron')
const path = require('path')
const fs = require('fs/promises')

/**
 * Scans the components directory and builds a tree of available components.
 * @param {string} componentsDir - The absolute path to the components directory.
 * @returns {Promise<object>} A promise that resolves to the component tree object.
 */
async function scanComponentDirectory(componentsDir) {
	const componentTree = {}
	try {
		const categories = await fs.readdir(componentsDir, { withFileTypes: true })
		for (const category of categories) {
			if (category.isDirectory()) {
				const categoryName = category.name
				const categoryPath = path.join(componentsDir, categoryName)
				const files = await fs.readdir(categoryPath)

				componentTree[categoryName] = files.filter(file => file.endsWith('.js')).map(file => path.basename(file, '.js'))
			}
		}
	} catch (error) {
		console.error(`ComponentAPI: Failed to scan component directory at ${componentsDir}:`, error)
		// Return an empty tree on error to prevent crashing the client
		return {}
	}
	return componentTree
}

/**
 * Initializes IPC handlers for loading component data.
 * @param {Electron.IpcMain} ipcMainInstance - The ipcMain instance.
 * @param {string} rootDirectory - The root directory of the application.
 */
function initComponentAPI(ipcMainInstance, rootDirectory) {
	const COMPONENTS_DIR = path.join(rootDirectory, 'modules/Components')
	// Start scanning the directory as soon as the API is initialized,
	// but don't block initialization. The result is stored in a promise.
	const componentTreePromise = scanComponentDirectory(COMPONENTS_DIR)
	
	ipcMainInstance.handle('get-component-tree', async () => {
		// This handler simply awaits the promise.
		// If the scan is already complete, it returns the cached result instantly.
		// If the scan is in progress, it waits for it to finish.
		return await componentTreePromise
	})
}

module.exports = { initComponentAPI }