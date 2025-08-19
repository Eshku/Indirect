const { app } = require('electron')

/**
 * Configures Electron app command line switches and environment variables.
 */
function initAppConfig() {
	// app.commandLine.appendSwitch('disable-frame-rate-limit'); // Disables VSync, can cause wobbly sprites if not handled well.
	app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer') // Necessary for certain web technologies.
	app.commandLine.appendSwitch('enable-unsafe-webgpu') // If you plan to use WebGPU.
	app.commandLine.appendSwitch('enable-webgpu-developer-features') // Additional WebGPU developer features.

	app.commandLine.appendSwitch('disable-renderer-backgrounding') // Prevents Electron from throttling renderer processes when window is in background.
	app.commandLine.appendSwitch('force_high_performance_gpu') // Attempts to force usage of dedicated GPU.

	// Disable security warnings in console. Use with caution and understand the implications.
	process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = false
}


module.exports = { initAppConfig }
