const path = require('path')

if (process.env.NODE_ENV === 'development') {
	const reloader = require('./scripts/reloader')
	const path = require('path')

	const app = __filename
	const appConfig = path.join(__dirname, 'appConfig.js')
	const electronFolder = path.join(__dirname, 'electron')
	const scriptsFolder = path.join(__dirname, 'scripts')

	const clientFolder = path.join(__dirname, 'client')

	const mainPaths = [app, appConfig, electronFolder, scriptsFolder]
	const clientPaths = [clientFolder]

	reloader.hard(mainPaths).soft(clientPaths)
}

const { app, BrowserWindow, screen, ipcMain, session } = require('electron')
// Import all API handlers from the barrel file
const {
	initPaths,
	initAppInfo,
	initDevTools,
	initUserDataDirectory,
	initFileSystem,
	initPrefabAPI,
	initComponentAPI,
	initSystemAPI,
	initManagerAPI,
	initWorkerAPI,
} = require('./electron/API')

const { initAppConfig } = require('./appConfig')

initUserDataDirectory()

// In this file, __dirname is the application root (the 'app/' directory)
// Pass it to any API initializers that need it.
initPaths(ipcMain, __dirname)
initAppInfo(ipcMain)
initFileSystem(ipcMain)
initPrefabAPI(ipcMain, __dirname)
initComponentAPI(ipcMain, __dirname)
initSystemAPI(ipcMain, __dirname)
initManagerAPI(ipcMain, __dirname)
initWorkerAPI(ipcMain, __dirname)

initAppConfig()

let mainWindow

/**
 * Creates and configures the main application window.
 */
function createMainWindow() {
	const primaryDisplay = screen.getPrimaryDisplay()
	const { width, height } = primaryDisplay.size

	mainWindow = new BrowserWindow({
		width: width,
		height: height,
		webPreferences: {
			contextIsolation: true,
			preload: path.join(__dirname, 'electron', 'preload.js'),
			nodeIntegration: false,
			enableRemoteModule: false,
		},
		frame: false,
		autoHideMenuBar: true,
		show: false,
	})

	mainWindow.loadFile(path.join(__dirname, 'client', 'index.html'))

	mainWindow.once('ready-to-show', () => {
		mainWindow.show()
		mainWindow.setResizable(false)

		/* 		if (process.env.NODE_ENV === 'development') { */
		mainWindow.webContents.openDevTools()
		/* } */

		// Setup IPC handlers that require mainWindow
		initDevTools(ipcMain, mainWindow)
	})
}

app.whenReady().then(() => {
	// This is the correct way to enable SharedArrayBuffer support.
	// It must be done before the window is created.
	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		callback({
			responseHeaders: {
				...details.responseHeaders,
				'Cross-Origin-Opener-Policy': 'same-origin',
				'Cross-Origin-Embedder-Policy': 'require-corp',
			},
		})
	})
	createMainWindow()
})

app.on('window-all-closed', () => {
	app.quit()
})
