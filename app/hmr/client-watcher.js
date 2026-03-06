/**
 * The HMR Client Watcher. This script is `require`'d by and runs *inside* the
 * main Electron process (`app.js`).
 *
 * Its role is to handle "live" updates for the client-side (renderer) code.
 * without requiring a full application restart. It watches the `app/client`
 * directory and decides what action to take based on the changed file:
 * - For a System file: It transpiles the code in-memory and sends an IPC message
 *   to the renderer for a hot-swap.
 * - For any other client file: It sends an IPC message to trigger a soft reload.
 */
const path = require('path')
const chokidar = require('chokidar')
const debounce = require('lodash/debounce')
const fs = require('fs/promises')
const { softReloadPaths, hmrPaths, hmrEnabledForSystems } = require('./config.js')
/**
 * Initializes the development server, which includes file watchers for hot-reloading.
 * @param {import('electron').App} app The Electron app instance.
 * @param {import('electron').BrowserWindow} BrowserWindow The Electron BrowserWindow class.
 */
function init(BrowserWindow) {
	console.log('[Client Watcher] Watching for client-side file changes.')

	const clientFolder = path.join(__dirname, '..', 'client')
	const systemsFolder = path.join(clientFolder, 'Systems')

	const getWindows = () => BrowserWindow.getAllWindows()

	const triggerHMR = debounce(async filePath => {
		const relativePath = path.relative(path.join(__dirname, '..', 'client'), filePath).replace(/\\/g, '/')
		const windows = getWindows()
		if (windows.length === 0) return

		try {
			const sourceCode = await fs.readFile(filePath, 'utf-8')

			// Hot-swap the system module on the main thread.
			console.log(`[Client Watcher] HMR: Sending raw code for ${relativePath} to SystemManager.`)
			windows.forEach(win => {
				if (win && !win.isDestroyed()) {
					win.webContents.send('hmr-update', { type: 'system-update', path: relativePath, code: sourceCode })
				}
			})
		} catch (error) {
			console.error(`[Client Watcher] Failed to process file for HMR: ${error.message}`)
		}
	}, 200)

	const triggerSoftReload = debounce(filePath => {
		const relativePath = path.relative(path.join(__dirname, '..', 'client'), filePath).replace(/\\/g, '/')
		const windows = getWindows()
		if (windows.length === 0) return

		console.log(`[Client Watcher] Client fil changed: ${relativePath}. Notifying for reload.`)
		windows.forEach(win => {
			if (win && !win.isDestroyed()) {
				win.webContents.send('hmr-update', { type: 'reload' })
			}
		})
	}, 200)

	const handleFileChange = filePath => {
		const isSystemFile = filePath.startsWith(systemsFolder) && filePath.endsWith('.js')

		if (isSystemFile && hmrEnabledForSystems) {
			triggerHMR(filePath)
		} else {
			triggerSoftReload(filePath)
		}
	}

	const watcherOptions = { ignored: /[/\\]\./, persistent: true, ignoreInitial: true }

	chokidar.watch(hmrPaths.concat(softReloadPaths), watcherOptions).on('change', handleFileChange)
}

module.exports = { init }
