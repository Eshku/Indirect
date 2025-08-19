const { ipcMain } = require('electron')

/**
 * Initializes IPC handlers related to developer tools.
 * @param {Electron.IpcMain} ipcMainInstance - The ipcMain instance.
 * @param {Electron.BrowserWindow} mainWindow - The main browser window.
 */
function initDevTools(ipcMainInstance, mainWindow) {
	ipcMainInstance.on('toggle-dev-tools', () => mainWindow.webContents.toggleDevTools())
}

module.exports = { initDevTools }
