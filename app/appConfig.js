const { app } = require('electron')

function initAppConfig() {
	// app.commandLine.appendSwitch('disable-frame-rate-limit'); // Disables VSync, can cause wobbly sprites if not handled well.
	app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')
	app.commandLine.appendSwitch('enable-unsafe-webgpu')
	app.commandLine.appendSwitch('enable-webgpu-developer-features')

	app.commandLine.appendSwitch('disable-renderer-backgrounding')
	app.commandLine.appendSwitch('force_high_performance_gpu')

	process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = false
}

module.exports = { initAppConfig }
