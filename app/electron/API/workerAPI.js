const { ipcMain } = require('electron')
const path = require('path')
const fs = require('fs/promises')

/**
 * Initializes IPC handlers related to Web Workers.
 * @param {Electron.IpcMain} ipcMainInstance - The ipcMain instance.
 * @param {string} rootDirectory - The root directory of the application.
 */
function initWorkerAPI(ipcMainInstance, rootDirectory) {
	const MODULES_DIR = path.join(rootDirectory, 'client')

	// This handler reads the worker script's content on the main process side
	// and sends it to the renderer. This bypasses all renderer-side pathing and
	// protocol issues for loading workers.
	ipcMainInstance.handle('get-worker-code', async (event, relativeWorkerPath) => {
		if (!relativeWorkerPath || typeof relativeWorkerPath !== 'string') {
			console.error('WorkerAPI: Invalid or no worker path provided.')
			return null
		}

		// Create a full, resolved path. path.join helps prevent some malicious inputs.
		const absoluteWorkerPath = path.join(MODULES_DIR, relativeWorkerPath)

		// This prevents path traversal attacks (e.g., using '../').
		if (!absoluteWorkerPath.startsWith(MODULES_DIR)) {
			console.error(`WorkerAPI: Access denied for path '${relativeWorkerPath}'.`)
			return null
		}

		//console.log(`[Main Process] Reading worker code from: ${absoluteWorkerPath}`)
		try {
			const code = await fs.readFile(absoluteWorkerPath, 'utf-8')
			return code
		} catch (error) {
			console.error(`[Main Process] Error loading worker code from '${absoluteWorkerPath}':`, error)
			// Return null to indicate failure, which the renderer can check for.
			return null
		}
	})
}

module.exports = { initWorkerAPI }
