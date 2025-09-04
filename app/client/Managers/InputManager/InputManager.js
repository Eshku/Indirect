const { eventEmitter } = await import(`${PATH_CORE}/Classes/EventEmitter.js`)
const { ControlSchemeLoader } = await import(`${PATH_MANAGERS}/InputManager/ControlSchemeLoader.js`)

class InputManager {
	/**
	 * Manages user input, including keyboard, mouse, and custom control schemes.
	 * It processes raw input events, maps them to game actions based on the active control scheme,
	 * and emits events for systems to react to.
	 * @property {Map<string, object>} controlSchemes - Stores registered control schemes by name.
	 * @property {object | null} activeControlScheme - The currently active control scheme object.
	 * @property {Map<string, boolean>} inputStates - Maps input codes (e.g., 'keyw', 'mouse0') to their active (pressed/held) state.
	 * @property {string[]} keySequenceBuffer - A buffer to store recent key presses for sequence detection.
	 * @property {number} maxSequenceLength - The maximum length of the key sequence buffer.
	 * @property {boolean} inputDisabled - True if input processing is globally disabled.
	 * @property {Set<string>} disableInputSources - A set of sources that have requested input to be disabled.
	 * @property {ControlSchemeLoader} controlSchemeLoader - Utility to load control schemes.
	 */
	constructor() {
		this.controlSchemes = new Map()
		this.activeControlScheme = null
		this.inputStates = new Map()

		this.keySequenceBuffer = []
		this.maxSequenceLength = 10

		this.inputDisabled = false
		this.disableInputSources = new Set()

		// Maps action names (e.g., 'Input MainAttack') to a Set of sources that have disabled it.
		this.disabledActions = new Map()

		this.controlSchemeLoader = new ControlSchemeLoader(this)
	}

	async init() {
		this.theManager = (await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)).theManager

		this.loadControlScheme()
		this.setupInputListeners()
	}

	async loadControlScheme() {
		try {
			await this.controlSchemeLoader.loadDefaultControlScheme()
		} catch (error) {
			console.error('Failed to load default control scheme:', error)
		}
	}

	disableInput(source) {
		this.disableInputSources.add(source)
		this.inputDisabled = this.disableInputSources.size > 0
	}

	enableInput(source) {
		this.disableInputSources.delete(source)
		this.inputDisabled = this.disableInputSources.size > 0
	}

	disableAction(actionName, source) {
		const sources = this.disabledActions.get(actionName)
		// If this is the first source to disable this action, we might need to send a deactivation event.
		const needsDeactivation = !sources || sources.size === 0

		if (!this.disabledActions.has(actionName)) {
			this.disabledActions.set(actionName, new Set())
		}
		this.disabledActions.get(actionName).add(source)

		if (needsDeactivation) {
			// Check if the action is currently active. If so, send a deactivation event
			// to ensure systems stop performing the action.
			for (const binding of this.activeControlScheme.bindings) {
				if (binding.action === actionName && this.inputStates.get(binding.input)) {
					// The raw input is active, so we need to tell listeners to deactivate.
					this.sendEvent(actionName, false)
					break // Found the binding, no need to continue.
				}
			}
		}
	}

	enableAction(actionName, source) {
		const sources = this.disabledActions.get(actionName)
		if (sources) {
			sources.delete(source)
			// If the action is now fully enabled (no more disabling sources)
			if (sources.size === 0) {
				// Check if the raw input is still active. If so, re-send the activation event.
				for (const binding of this.activeControlScheme.bindings) {
					if (binding.action === actionName && this.inputStates.get(binding.input)) {
						this.sendEvent(actionName, true)
						break // Found the binding, no need to continue.
					}
				}
			}
		}
	}

	setupInputListeners() {
		const handleKeyDown = event => {
			// Prevent default browser actions for game-related keys.
			// This stops things like F5 refreshing the page or spacebar scrolling.
			event.preventDefault()
			event.stopPropagation()

			const code = event.code.toLowerCase()
			this.updateInputState(code, true)
		}

		const handleKeyUp = event => {
			event.preventDefault()
			event.stopPropagation()

			const code = event.code.toLowerCase()
			this.updateInputState(code, false)
		}

		const handleMouseDown = event => {
			// We don't preventDefault on mouse down to allow text selection in debug inputs, etc.
			// performane monitor still rely on it.
			// event.preventDefault();
			const button = `mouse${event.button}`
			this.updateInputState(button, true)
		}

		const handleMouseUp = event => {
			const button = `mouse${event.button}`
			this.updateInputState(button, false)
		}

		const handleMouseWheel = event => {
			const direction = event.deltaY > 0 ? 'WheelDown' : 'WheelUp'
			const value = event.deltaY
			this.handleMouseWheelEvent(direction, value)
		}

		const handleBlur = () => {
			for (const key of this.inputStates.keys()) {
				this.updateInputState(key, false)
			}
		}

		window.addEventListener('keydown', handleKeyDown)
		window.addEventListener('keyup', handleKeyUp)
		window.addEventListener('mousedown', handleMouseDown)
		window.addEventListener('mouseup', handleMouseUp)
		window.addEventListener('wheel', handleMouseWheel)
		window.addEventListener('blur', handleBlur)
	}

	updateInputState(input, isActive) {
		const previousState = this.inputStates.get(input)

		if (previousState !== isActive) {
			this.inputStates.set(input, isActive)
			this.handleInput(input, isActive)
		}
	}

	handleInput(input, isActive) {
		if (!this.activeControlScheme || this.inputDisabled) return

		for (const binding of this.activeControlScheme.bindings) {
			if (binding.type === 'combination') {
				if (this.isCombinationActive(binding.input)) {
					this.sendEvent(binding.action, isActive)
				}
			} else if (binding.type === 'sequence') {
				this.handleSequenceInput(binding, input, isActive)
			} else if (binding.type === 'key' && binding.input === input) {
				this.sendEvent(binding.action, isActive)
			} else if (binding.type === 'mouseButton' && binding.input === input) {
				this.sendEvent(binding.action, isActive)
			}
		}
	}

	handleSequenceInput(binding, input, isActive) {
		if (isActive) {
			this.keySequenceBuffer.push(input)
			if (this.keySequenceBuffer.length > this.maxSequenceLength) {
				this.keySequenceBuffer.shift()
			}
			if (this.keySequenceBuffer.slice(-binding.input.length).join('') === binding.input.join('')) {
				this.sendEvent(binding.action, true)
			}
		}
	}

	isCombinationActive(combination) {
		return combination.every(key => this.inputStates.get(key))
	}

	handleMouseWheelEvent(direction, value) {}

	sendEvent(actionName, isActive) {
		const sources = this.disabledActions.get(actionName)
		if (sources && sources.size > 0) {
			// If the action is disabled, we only allow 'deactivation' events through.
			// This ensures that if an action was active (e.g., holding mouse down) and then
			// becomes disabled (e.g., moving over UI), the 'key up' event is still sent
			// to correctly reset the state in other systems.
			if (isActive) return
		}
		eventEmitter.emit(actionName, { isActive })
	}
}

export const inputManager = new InputManager()
