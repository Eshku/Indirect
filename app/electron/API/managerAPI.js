const { ipcMain } = require('electron')
const path = require('path')
const fs = require('fs/promises')

/**
 * Scans the managers directory and builds a tree of available managers.
 * The structure is { ManagerName: [file1, file2, ...] }. The loader then
 * uses this to find the main ManagerName.js file.
 * @param {string} managersDir - The absolute path to the managers directory.
 * @returns {Promise<object>} A promise that resolves to the manager tree object.
 */
async function scanManagerDirectory(managersDir) {
	const managerTree = {}
	try {
		const managerFolders = await fs.readdir(managersDir, { withFileTypes: true })
		for (const folder of managerFolders) {
			if (folder.isDirectory()) {
				const managerName = folder.name
				const managerPath = path.join(managersDir, managerName)
				const files = await fs.readdir(managerPath)

				managerTree[managerName] = files.filter(file => file.endsWith('.js')).map(file => path.basename(file, '.js'))
			}
		}
	} catch (error) {
		console.error(`ManagerAPI: Failed to scan manager directory at ${managersDir}:`, error)
		return {}
	}
	return managerTree
}

/**
 * Initializes IPC handlers for loading manager data.
 * @param {Electron.IpcMain} ipcMainInstance - The ipcMain instance.
 * @param {string} rootDirectory - The root directory of the application.
 */
function initManagerAPI(ipcMainInstance, rootDirectory) {
	const MANAGERS_DIR = path.join(rootDirectory, 'client/Managers')
	const managerTreePromise = scanManagerDirectory(MANAGERS_DIR)

	ipcMainInstance.handle('get-manager-tree', async () => await managerTreePromise)
}

module.exports = { initManagerAPI }