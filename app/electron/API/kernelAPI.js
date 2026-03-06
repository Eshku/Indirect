const { ipcMain } = require('electron')
const path = require('path')
const fs = require('fs/promises')

/**
 * Scans the kernels directory and builds a flat list of available kernel modules.
 * @param {string} kernelsDir - The absolute path to the kernels directory.
 * @returns {Promise<string[]>} A promise that resolves to a flat array of kernel module names.
 */
async function scanKernelDirectory(kernelsDir) {
	try {
		const files = await fs.readdir(kernelsDir)
		// Filter for files ending in .js. The client-side loader expects the full filename.
		return files.filter(file => file.endsWith('.js'))
	} catch (error) {
		// If the directory doesn't exist or can't be read, log the error but don't crash.
		console.error(`KernelAPI: Failed to scan kernel directory at ${kernelsDir}:`, error)
		// Return an empty array on error to prevent crashing the client.
		return []
	}
}

/**
 * Initializes IPC handlers for loading kernel data.
 * @param {import('electron').IpcMain} ipcMainInstance - The ipcMain instance from Electron.
 * @param {string} appRoot - The absolute path to the project's root directory.
 */
function initKernelAPI(ipcMainInstance, appRoot) {
	const KERNELS_DIR = path.join(appRoot, 'client', 'Kernels')
	const kernelFilesPromise = scanKernelDirectory(KERNELS_DIR)
	ipcMainInstance.handle('get-kernel-tree', async () => await kernelFilesPromise)

	ipcMainInstance.handle('get-kernel-source', async (event, fileName) => {
		const absolutePath = path.join(KERNELS_DIR, fileName)
		// Security: Ensure the path is within the allowed directory.
		if (!absolutePath.startsWith(KERNELS_DIR)) {
			console.error(`KernelAPI: Access denied for path '${fileName}'.`)
			return null
		}
		try {
			return await fs.readFile(absolutePath, 'utf-8')
		} catch (error) {
			console.error(`KernelAPI: Error reading kernel source from '${absolutePath}':`, error)
			return null
		}
	})
}

module.exports = { initKernelAPI }
