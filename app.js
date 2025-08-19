if (process.env.NODE_ENV === 'development') {
	require('electron-reload')(__dirname, {
		electron: require(`${__dirname}/node_modules/electron`),
	})
}
const { app, BrowserWindow, screen, ipcMain, session } = require('electron')
const path = require('path')
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
} = require('./API')

const { initAppConfig } = require('./appConfig')

initUserDataDirectory()

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
			preload: path.join(__dirname, './preload.js'),
			nodeIntegration: false,
			enableRemoteModule: false,
		},
		frame: false,
		autoHideMenuBar: true,
		show: false,
	})

	mainWindow.loadFile('index.html')

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

//const usedMemory = process.memoryUsage().heapUsed / 1024 / 1024; // In MB
