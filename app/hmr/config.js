const path = require('path')

const root = path.join(__dirname, '..') // `__dirname` is now `app/hmr`, so `..` is `app`
const clientFolder = path.join(root, 'client')
const systemsFolder = path.join(clientFolder, 'Systems')

/**
 * Centralized configuration for the HMR (Hot Module Replacement) system.
 *
 * This file acts as the single source of truth that defines which file paths
 * should trigger which type of reload. It is used by both the `supervisor.js`
 * (for hard reloads) and the `client-watcher.js` (for soft reloads and HMR).
 */
module.exports = {
	//! Client-side HMR manager and expose HMR.enable(), HMR.disable()?

	//! probably not going to be fully implemented until I figure out and build proper foundation.

	//! for future self - if one of the systems using HMR in memory and then one of the other modules
	//! doing soft-reload as there is no hook for it yet
	//! then system module is going to be outdated - it was not transpiled and saved as a file.

	//! just save all as file for now figure out in memory later? Do as file forever, as "good enough"? Is it good enough tho?
	//! gonna check out how fast is it with files.

	//! How to fix data corruption on workers, simple way:

	// 0. We catch HMR singal and store it as part of game loop \ scheduler.
	// 1. At the end of a frame after "natural" command buffer trigger we pause the loop - workers are sleeping, no jobs are being done.
	// 2. system.destroy will be called => we might need to call command buffer again (even if should be redundent, better safe.)
	// 3. pause game loop.
	// 4. replace module
	// 5. completely delete all workers data.
	// 6. Resync it again.
	// 7. Resume loop as if nothing hapenned.

	// should still be relatively fast for humans.
	//____
	// ^ transpiler no longer a thing.

	/**
	 * If true, system file changes will trigger a hot-swap.
	 * If false, they will trigger a soft reload (full page refresh).
	 */

	hmrEnabledForSystems: false, //! disabled as not ready for parallel systems.
	// Paths that trigger a full application restart.
	// Watched by the external `dev-launcher.js`.
	mainProcessPaths: [
		path.join(root, 'app.js'),
		path.join(root, 'appConfig.js'),
		path.join(root, 'electron'),
		// Watch the HMR files themselves for changes.
		path.join(root, 'hmr', 'supervisor.js'),
		path.join(root, 'hmr', 'client-watcher.js'),
	],

	// Paths that trigger a soft reload of the renderer process.
	// Watched by the in-app `dev-server.js`.
	// We watch the whole client folder but ignore the more specific HMR paths.
	softReloadPaths: [clientFolder],

	// Paths that trigger Hot Module Replacement without a page reload.
	// Watched by the in-app `dev-server.js`.
	hmrPaths: [path.join(systemsFolder, '**', '*.js')],
}
