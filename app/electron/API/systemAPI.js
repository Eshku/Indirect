const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');

/**
 * Scans the systems directory and builds a tree of available systems.
 * @param {string} systemsDir - The absolute path to the systems directory.
 * @returns {Promise<Record<string, string[]>>} A promise that resolves to the system tree object.
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
				systemTree[categoryName] = files
					.filter(file => file.endsWith('.js'))
					.map(file => path.basename(file, '.js'));
			}
		}
	} catch (error) {
		// If the directory doesn't exist or can't be read, log the error but don't crash.
		console.error(`SystemAPI: Failed to scan system directory at ${systemsDir}:`, error)
		// Return an empty tree on error to prevent crashing the client
		return {}
	}
	return systemTree;
}

/**
 * Initializes IPC handlers for loading system data.
 * It's crucial that this function receives the absolute path to the project's root directory
 * to correctly locate the 'client/Systems' folder.
 * @param {import('electron').IpcMain} ipcMainInstance - The ipcMain instance from Electron.
 * @param {string} projectRoot - The absolute path to the project's root directory.
 */
function initSystemAPI(ipcMainInstance, appRoot) {
	// Construct the absolute path to the Systems directory from the project root.
	const SYSTEMS_DIR = path.join(appRoot, 'client', 'Systems');

	// Pre-scan the directory on startup so the data is ready for the renderer.
	const systemTreePromise = scanSystemDirectory(SYSTEMS_DIR);

	// Handler to provide the pre-scanned system tree to the renderer.
	ipcMainInstance.handle('get-system-tree', async () => {
		return await systemTreePromise;
	});
	// Handler to provide the source code of a specific system file to the renderer.
	ipcMainInstance.handle('get-system-source', async (event, relativePath) => {
		if (!relativePath || typeof relativePath !== 'string') {
			console.error('SystemAPI: Invalid or no system path provided.')
			return null
		}

		// Create a full, resolved path. path.join helps prevent some malicious inputs.
		const absolutePath = path.join(SYSTEMS_DIR, relativePath)

		// SECURITY: Crucially, verify that the resolved path is still inside the allowed SYSTEMS_DIR.
		// This prevents path traversal attacks (e.g., using '../' to access other files).
		if (!absolutePath.startsWith(SYSTEMS_DIR)) {
			console.error(`SystemAPI: Access denied for path '${relativePath}'. Attempted to access outside of the sandboxed Systems directory.`);
			return null
		}

		try {
			const code = await fs.readFile(absolutePath, 'utf-8')
			return code;
		} catch (error) {
			console.error(`SystemAPI: Error reading system source from '${absolutePath}':`, error)
			return null;
		}
	})
}

module.exports = { initSystemAPI };