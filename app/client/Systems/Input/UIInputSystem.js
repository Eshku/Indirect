const { eventEmitter } = await import(`${PATH_CORE}/Classes/EventEmitter.js`)

const { engine } = await import(`${PATH_CLIENT}/Engine.js`)

const { uiManager, inputManager } = engine.getManagers()



/**
 * Handles UI and application-level input actions by listening for abstract input events.
 * This class listens for abstract input events (like 'ToggleConsole') and
 * performs actions that are outside the main ECS simulation loop, such as
 * interacting with the developer console, closing the window, or toggling
 * top-level UI elements. It acts as a centralized place for UI and App hotkeys.
 */
export class UIInputSystem {
	constructor() {}

	/**
	 * Sets up all the global input event listeners. This should be called once during app initialization.
	 */
	init() {
		// Bind handlers to ensure 'this' context and allow for correct removal in destroy().
		this._onToggleConsole = this._onToggleConsole.bind(this)
		this._onTogglePlayerInterface = this._onTogglePlayerInterface.bind(this)
		this._onCustomClose = this._onCustomClose.bind(this)
		this._onSecretSequence = this._onSecretSequence.bind(this)

		this.setupEventListeners()
	}

	setupEventListeners() {
		eventEmitter.on('Input ToggleConsole', this._onToggleConsole)
		eventEmitter.on('Input TogglePlayerInterface', this._onTogglePlayerInterface)
		eventEmitter.on('Input CustomClose', this._onCustomClose)
		eventEmitter.on('Input SecretSequence', this._onSecretSequence)
	}

	_onToggleConsole(key) {
		if (key.isActive) {
			if (window.electronAPI?.toggleDevTools) {
				window.electronAPI.toggleDevTools()
			} else {
				console.error('electronAPI.toggleDevTools is not available.')
			}
		}
	}

	_onTogglePlayerInterface(key) {
		if (key.isActive) {
			// disable/enable player controls to prevent movement while the UI is open.
			const isNowVisible = uiManager.toggle('someUIWindow')
			if (isNowVisible) {
				inputManager.disableInput('ui')
			} else {
				inputManager.enableInput('ui')
			}
			console.log(`TogglePlayerInterface action. UI is now ${isNowVisible ? 'visible' : 'hidden'}.`)
		}
	}

	_onCustomClose(key) {
		if (key.isActive) {
			window.close()
		}
	}

	_onSecretSequence(key) {
		if (key.isActive) {
			console.log('Secret sequence activated!')
		}
	}

	destroy() {
		// Remove all listeners to prevent memory leaks and duplicate handlers on HMR.
		eventEmitter.off('Input ToggleConsole', this._onToggleConsole)
		eventEmitter.off('Input TogglePlayerInterface', this._onTogglePlayerInterface)
		eventEmitter.off('Input CustomClose', this._onCustomClose)
		eventEmitter.off('Input SecretSequence', this._onSecretSequence)
	}
}
