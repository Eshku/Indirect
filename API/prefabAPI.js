const { ipcMain } = require('electron')
const path = require('path')
const fs = require('fs/promises')

/**
 * Initializes IPC handlers for loading prefab data and the prefab manifest.
 * @param {Electron.IpcMain} ipcMainInstance - The ipcMain instance.
 * @param {string} rootDirectory - The root directory of the application.
 */
function initPrefabAPI(ipcMainInstance, rootDirectory) {
	// Handler for individual prefab JSON files, now using root-relative paths.
	ipcMainInstance.handle('get-prefab-data', async (event, prefabPath) => {
		try {
			// Sanitize the prefabPath to prevent path traversal.
			const normalizedPath = path.normalize(prefabPath).replace(/\\/g, '/')
			if (normalizedPath.includes('..') || path.isAbsolute(normalizedPath)) {
				console.error(`PrefabAPI: Access denied for invalid path format: '${prefabPath}'.`)
				return null
			}

			// Construct the full path. path.join is safe against null-byte attacks etc.
			const absoluteFilePath = path.join(rootDirectory, normalizedPath)

			// Final, most critical check to ensure the path has not escaped the project directory.
			if (!absoluteFilePath.startsWith(rootDirectory)) {
				console.error(`PrefabAPI: Access denied for path '${prefabPath}'.`)
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
			const absoluteFilePath = path.join(rootDirectory, 'modules/Data', 'prefabs.manifest.json')
			const fileContent = await fs.readFile(absoluteFilePath, 'utf-8')
			return JSON.parse(fileContent)
		} catch (error) {
			console.error(`PrefabAPI: Error loading prefab manifest:`, error.message)
			return null
		}
	})
}

module.exports = { initPrefabAPI }