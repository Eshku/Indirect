const { eventEmitter } = await import(`${PATH_CORE}/Classes/EventEmitter.js`)
const { uiManager, inputManager } = (await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)).theManager.getManagers()

/**
 * Handles UI and application-level input actions by listening for abstract input events.
 * This class listens for abstract input events (like 'ToggleConsole') and
 * performs actions that are outside the main ECS simulation loop, such as
 * interacting with the developer console, closing the window, or toggling
 * top-level UI elements. It acts as a centralized place for UI and App hotkeys.
 */
export class UIInputSystem {
	constructor() {
		// Dependencies can be injected here if needed in the future.
	}

	/**
	 * Sets up all the global input event listeners. This should be called once during app initialization.
	 */
	init() {
		this.setupConsoleToggle()
		this.setupInterfaceToggle()
		this.setupWindowControls()
		this.setupSecretSequence()
	}

	/**
	 * Listens for the action to toggle the developer console.
	 */
	setupConsoleToggle() {
		eventEmitter.on('Input ToggleConsole', key => {
			if (key.isActive) {
				if (window.electronAPI?.toggleDevTools) {
					window.electronAPI.toggleDevTools()
				} else {
					console.error('electronAPI.toggleDevTools is not available.')
				}
			}
		})
	}

    
	/**
	 * Listens for the action to toggle a UI interface.
	 */
	setupInterfaceToggle() {
		eventEmitter.on('Input TogglePlayerInterface', key => {
			if (key.isActive) {
				// This is an example of how you might toggle a UI window and
				// disable/enable player controls to prevent movement while the UI is open.
				const isNowVisible = uiManager.toggle('someUIWindow')
				if (isNowVisible) {
					inputManager.disableInput('ui')
				} else {
					inputManager.enableInput('ui')
				}
				console.log(`TogglePlayerInterface action. UI is now ${isNowVisible ? 'visible' : 'hidden'}.`)
			}
		})
	}

	/**
	 * Listens for actions related to window management, like closing the app.
	 */
	setupWindowControls() {
		eventEmitter.on('Input CustomClose', key => {
			if (key.isActive) {
				window.close()
			}
		})
	}

	/**
	 * Listens for a secret key sequence.
	 */
	setupSecretSequence() {
		eventEmitter.on('Input SecretSequence', key => {
			if (key.isActive) {
				console.log('Secret sequence activated!')
			}
		})
	}
}