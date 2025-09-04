const { ipcMain } = require('electron')

/**
 * Initializes IPC handlers related to application information.
 * @param {Electron.IpcMain} ipcMainInstance - The ipcMain instance.
 */
function initAppInfo(ipcMainInstance) {
	ipcMainInstance.handle('get-env', async () => process.env.NODE_ENV)
}

module.exports = { initAppInfo }
