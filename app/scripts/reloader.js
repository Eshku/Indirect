const chokidar = require('chokidar')
const path = require('path')
const { app, BrowserWindow } = require('electron')
const debounce = require('lodash/debounce')

/**
 * A hot-reloader for Electron applications.
 */
class Reloader {
	/**
	 * Constructs a new Reloader instance.
	 */
	constructor() {
		this.rootPath = app.getAppPath()
		this.watchers = []
		console.log('[Reloader] Watching for file changes.')
	}

	/**
	 * Watches a path or paths and executes a debounced callback on change.
	 * @param {string|string[]} paths - Path(s) to watch.
	 * @param {Function} callback - Function to execute on change.
	 * @private
	 */
	_watch(paths, callback) {
		const watcher = chokidar.watch(paths, {
			ignored: /[/\\]\./, // ignore dotfiles
			persistent: true,
		})

		watcher.on('change', filePath => {
			console.log(`[Reloader] File changed: ${path.relative(this.rootPath, filePath)}`)
			callback()
		})

		this.watchers.push(watcher)
	}

	/**
	 * Sets up watching for renderer process files, which triggers a soft reload
	 * (reloading all browser windows).
	 * @param {string|string[]} paths - Path(s) to watch.
	 * @returns {Reloader} The Reloader instance for chaining.
	 */
	soft(paths) {
		const reloadWindows = debounce(() => {
			console.log('[Reloader] Renderer files changed. Reloading windows...')
			BrowserWindow.getAllWindows().forEach(win => {
				if (win && !win.isDestroyed()) {
					win.webContents.reloadIgnoringCache()
				}
			})
		}, 200)

		this._watch(paths, reloadWindows)
		return this
	}

	/**
	 * Sets up watching for main process files, which triggers a hard reload
	 * (restarting the application).
	 * @param {string|string[]} paths - Path(s) to watch.
	 * @returns {Reloader} The Reloader instance for chaining.
	 */
	hard(paths) {
		const restartApp = debounce(() => {
			console.log('[Reloader] Main process files changed. Restarting...')
			app.relaunch()
			app.quit()
		}, 200)

		this._watch(paths, restartApp)
		return this
	}
}

module.exports = new Reloader()
