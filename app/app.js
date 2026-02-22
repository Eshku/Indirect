const path = require('path')

const { app, BrowserWindow, screen, ipcMain, session } = require('electron')

if (process.env.NODE_ENV === 'development') {
	const clientWatcher = require('./hmr/client-watcher.js')
	clientWatcher.init(BrowserWindow)
}

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
			backgroundThrottling: false,
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
	// Enable SharedArrayBuffer support.
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
