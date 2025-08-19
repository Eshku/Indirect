const { ipcMain } = require('electron')

/**
 * Initializes IPC handlers related to paths.
 * @param {Electron.IpcMain} ipcMainInstance - The ipcMain instance.
 * @param {string} rootDirectory - The root directory of the application.
 */
function initPaths(ipcMainInstance, rootDirectory) {
	ipcMainInstance.handle('get-root-directory', async () => rootDirectory)
}

module.exports = {
	initPaths,
}
