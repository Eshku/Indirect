/**
 * The HMR Supervisor. This is the true entry point for `npm start`.
 *
 * Its role is analogous to `nodemon`. It is a simple, persistent Node.js process
 * that runs *outside* of Electron. Its only job is to:
 * 1. Spawn the main Electron application as a child process.
 * 2. Watch the core application files (defined in `config.js`) for changes.
 * 3. When a change is detected, kill the entire Electron process and start a new one.
 *
 * This parent-child process model solves the "disconnected console" problem. Because
 * this supervisor script never terminates, the connection to your IDE's terminal
 * is maintained, and the console output from each new Electron instance is correctly piped through.
 */
const { spawn } = require('child_process')
const path = require('path')
const chokidar = require('chokidar')

const { mainProcessPaths } = require('./config.js')
const electronPath = require('electron') // Gets the path to the electron executable

let electronProcess = null;
let manualRestart = false;

function startElectron() {
	console.log('[Supervisor] Starting Electron application...')
	// The `stdio: 'inherit'` option is crucial. It pipes the child's console
	// output to this parent process, so we can see it in our terminal.
	electronProcess = spawn(electronPath, ['.'], { stdio: 'inherit' })

	electronProcess.on('close', (code, signal) => {
		if (code !== 0 && code !== null) {
			console.error(`[Supervisor] Electron process exited with code ${code} and signal ${signal}`)
		}

		// If `manualRestart` is true, it means we triggered the kill.
		// We can now safely start the new process.
		if (manualRestart) {
			manualRestart = false;
			startElectron();
		} else {
			// If the process closed and we didn't trigger it, it was a manual close.
			console.log('[Supervisor] Electron app closed. Exiting supervisor.');
			process.exit(0);
		}
	})
}

const watcherOptions = { ignored: /[/\\]\./, persistent: true, ignoreInitial: true };

chokidar.watch(mainProcessPaths, watcherOptions).on('change', (filePath) => {
	console.log(`[Supervisor] Main process file changed: ${path.relative(process.cwd(), filePath)}. Restarting...`);
	manualRestart = true;
	if (electronProcess) {
		electronProcess.kill();
	}
})

// Start the first instance
startElectron()