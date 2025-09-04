const { ipcMain } = require('electron')
const path = require('path')
const fs = require('fs/promises')

/**
 * Initializes IPC handlers for loading prefab data and the prefab manifest.
 * @param {Electron.IpcMain} ipcMainInstance - The ipcMain instance.
 * @param {string} appRoot - The root directory of the application (the 'app/' folder).
 */
function initPrefabAPI(ipcMainInstance, appRoot) {
	// Handler for individual prefab JSON files.
	// Expects a path relative to the appRoot, e.g., "client/Data/Prefabs/Playable/Player.json"
	ipcMainInstance.handle('get-prefab-data', async (event, prefabPath) => {
		//console.log(`Requesting prefab data for: ${prefabPath}`)
		try {
			// path.join is used to construct a safe, cross-platform path.
			// It also implicitly normalizes the path.
			const absoluteFilePath = path.join(appRoot, prefabPath)

			// Security: Crucially, verify that the resolved path is still within the appRoot.
			// This prevents path traversal attacks (e.g., using '../' in prefabPath).
			if (!absoluteFilePath.startsWith(appRoot)) {
				console.error(`PrefabAPI: Access denied for path '${prefabPath}'. It resolves outside the application root.`)
				return null
			}

			const fileContent = await fs.readFile(absoluteFilePath, 'utf-8')
			return JSON.parse(fileContent)
		} catch (error) {
			// Log the error but return null to the client so it can handle the failure gracefully.
			console.error(`PrefabAPI: Error loading prefab '${prefabPath}':`, error.message)
			return null
		}
	})

	// Handler for the main prefab manifest file.
	ipcMainInstance.handle('get-prefab-manifest', async () => {
		try {
			const absoluteFilePath = path.join(appRoot, 'client/Data', 'prefabs.manifest.json')
			const fileContent = await fs.readFile(absoluteFilePath, 'utf-8')
			return JSON.parse(fileContent)
		} catch (error) {
			console.error(`PrefabAPI: Error loading prefab manifest:`, error.message)
			return null
		}
	})
}

module.exports = { initPrefabAPI }
