/**
 * A simple system to test that numeric (timed) frequencies are working correctly.
 * It should log a message to the console at its configured interval.
 */
export class TimedSystemTest {
	constructor() {
		// No setup needed for this simple test.
		this.lastRunTick = -1
	}

	init() {
		console.log('[TimedSystemTest] Initialized. Will run at its configured frequency.')
	}

	update({ deltaTime, currentVersion, lastVersion }) {
		// Avoid logging on the very first frame if it happens to run.
		if (this.lastRunTick === currentVersion) return

		console.log(
			`%c[TimedSystemTest] Update called at version: ${currentVersion}. (DeltaTime since last run: ${deltaTime.toFixed(4)}s)`,
			'color: yellow'
		)

		this.lastRunTick = currentVersion
	}

	destroy() {}
}