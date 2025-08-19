const { ipcMain } = require('electron')
const path = require('path')
const fs = require('fs/promises')

/**
 * Scans the systems directory and builds a tree of available systems.
 * @param {string} systemsDir - The absolute path to the systems directory.
 * @returns {Promise<object>} A promise that resolves to the system tree object.
 */
async function scanSystemDirectory(systemsDir) {
	const systemTree = {}
	try {
		const categories = await fs.readdir(systemsDir, { withFileTypes: true })
		for (const category of categories) {
			if (category.isDirectory()) {
				const categoryName = category.name
				const categoryPath = path.join(systemsDir, categoryName)
				const files = await fs.readdir(categoryPath)

				systemTree[categoryName] = files.filter(file => file.endsWith('.js')).map(file => path.basename(file, '.js'))
			}
		}
	} catch (error) {
		console.error(`SystemAPI: Failed to scan system directory at ${systemsDir}:`, error)
		// Return an empty tree on error to prevent crashing the client
		return {}
	}
	return systemTree
}

/**
 * Initializes IPC handlers for loading system data.
 * @param {Electron.IpcMain} ipcMainInstance - The ipcMain instance.
 * @param {string} rootDirectory - The root directory of the application.
 */
function initSystemAPI(ipcMainInstance, rootDirectory) {
	const SYSTEMS_DIR = path.join(rootDirectory, 'modules/Systems')
	const systemTreePromise = scanSystemDirectory(SYSTEMS_DIR)

	ipcMainInstance.handle('get-system-tree', async () => await systemTreePromise)

	ipcMainInstance.handle('get-system-source', async (event, relativePath) => {
		if (!relativePath || typeof relativePath !== 'string') {
			console.error('SystemAPI: Invalid or no system path provided.')
			return null
		}

		// Create a full, resolved path. path.join helps prevent some malicious inputs.
		const absolutePath = path.join(SYSTEMS_DIR, relativePath)

		// SECURITY: Crucially, verify that the resolved path is still inside the allowed SYSTEMS_DIR.
		// This prevents path traversal attacks (e.g., using '../').
		if (!absolutePath.startsWith(SYSTEMS_DIR)) {
			console.error(`SystemAPI: Access denied for path '${relativePath}'.`)
			return null
		}

		try {
			const code = await fs.readFile(absolutePath, 'utf-8')
			return code
		} catch (error) {
			console.error(`SystemAPI: Error reading system source from '${absolutePath}':`, error)
			return null
		}
	})
}

module.exports = { initSystemAPI }