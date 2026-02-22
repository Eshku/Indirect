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
const babel = require('@babel/core')
const { softReloadPaths, hmrPaths, hmrEnabledForSystems } = require('./config.js')
/**
 * Initializes the development server, which includes file watchers for hot-reloading.
 * @param {import('electron').App} app The Electron app instance.
 * @param {import('electron').BrowserWindow} BrowserWindow The Electron BrowserWindow class.
 */
function init(BrowserWindow) {
	console.log('[Client Watcher] Watching for client-side file changes.')

	// Babel plugin needs to be imported dynamically as it's an ES module.
	let extractSchedulePlugin;
	import('../scripts/babel-plugin-extract-schedule.js').then(module => {
		extractSchedulePlugin = module.default;
	});

	const clientFolder = path.join(__dirname, '..', 'client');
    const systemsFolder = path.join(clientFolder, 'Systems');

	const getWindows = () => BrowserWindow.getAllWindows()

	const triggerHMR = debounce(async (filePath) => {
		const relativePath = path.relative(path.join(__dirname, '..', 'client'), filePath).replace(/\\/g, '/')
		const windows = getWindows()
		if (windows.length === 0) return

		try {
			if (!extractSchedulePlugin) {
				console.warn('[Client Watcher] HMR triggered, but babel plugin not yet loaded. Skipping.');
				return;
			}

			const sourceCode = await fs.readFile(filePath, 'utf-8')

			// --- Path 1: Hot-Swap for SystemManager (Main Thread) ---
			// Send the raw, full system class code for the main thread to hot-swap.
			console.log(`[Client Watcher] HMR: Sending raw code for ${relativePath} to SystemManager.`)
			windows.forEach(win => {
				if (win && !win.isDestroyed()) {
					win.webContents.send('hmr-update', { type: 'system-update', path: relativePath, code: sourceCode })
				}
			})

			// --- Path 2: Transpile for WorkerManager (Parallel Execution) ---
			const result = await babel.transformAsync(sourceCode, {
				plugins: [extractSchedulePlugin],
				sourceType: 'module',
				filename: filePath,
			});

			if (result.metadata.isParallel) {
				console.log(`[Client Watcher] HMR: Sending transpiled 'schedule' logic for ${result.metadata.systemName} to WorkerManager.`);
				windows.forEach(win => {
					if (win && !win.isDestroyed()) {
						// Send the metadata object from the babel result directly
						win.webContents.send('hmr-update', {
							type: 'schedule-update',
							...result.metadata,
							code: result.code
						});
					}
				});
			}
		} catch (error) {
			console.error(`[Client Watcher] Failed to process file for HMR: ${error.message}`)
		}
	}, 200)

	const triggerSoftReload = debounce((filePath) => {
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

	const handleFileChange = (filePath) => {
        const isSystemFile = filePath.startsWith(systemsFolder) && filePath.endsWith('.js');

        if (isSystemFile && hmrEnabledForSystems) {
            triggerHMR(filePath);
        } else {
            triggerSoftReload(filePath);
        }
    };

	const watcherOptions = { ignored: /[/\\]\./, persistent: true, ignoreInitial: true }

	chokidar.watch(hmrPaths.concat(softReloadPaths), watcherOptions).on('change', handleFileChange)
}

module.exports = { init }