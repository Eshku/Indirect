const { app, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const USER_DATA_DIRECTORY = path.join(app.getPath('userData'), 'userData')

function initUserDataDirectory() {
	if (!fs.existsSync(USER_DATA_DIRECTORY)) {
		console.log(`Creating save directory: ${USER_DATA_DIRECTORY}`)
		fs.mkdirSync(USER_DATA_DIRECTORY, { recursive: true })
	}
}

/**
 * Initializes IPC handlers related to the file system.
 * @param {Electron.IpcMain} ipcMainInstance - The ipcMain instance.
 */
function initFileSystem(ipcMainInstance) {
	ipcMainInstance.handle('save-file', async (event, filePath, data) => {
		try {
			// Ensure the path is within USER_DATA_DIRECTORY and sanitize the filename part.
			const safeFileName = path.basename(filePath) // Extracts filename, discarding any directory traversal attempts from filePath string
			const absoluteFilePath = path.resolve(USER_DATA_DIRECTORY, safeFileName)

			if (!absoluteFilePath.startsWith(USER_DATA_DIRECTORY)) {
				console.error('Error saving file: Attempt to save outside of designated directory or invalid path components.')
				return false
			}

			fs.writeFileSync(absoluteFilePath, data)
			return true
		} catch (error) {
			console.error('Error saving file:', error)
			return false
		}
	})
}

module.exports = {
	initUserDataDirectory,
	initFileSystem,
	USER_DATA_DIRECTORY,
}
