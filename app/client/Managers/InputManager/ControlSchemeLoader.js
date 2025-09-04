export class ControlSchemeLoader {
	constructor(inputManager) {
		this.inputManager = inputManager
	}

	async loadControlScheme(controlScheme) {
		if (!this.validateControlScheme(controlScheme)) {
			console.error('Invalid control scheme format:', controlScheme)
			return
		}

		const normalizedControlScheme = this.normalizeControlScheme(controlScheme)
		this.inputManager.controlSchemes.set(normalizedControlScheme.name, normalizedControlScheme)
		this.inputManager.activeControlScheme = normalizedControlScheme
	}

	async loadDefaultControlScheme() {
		try {
			const response = await fetch(`${PATH_MANAGERS}/InputManager/ControlScheme.json`)

			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`)
			}
			const controlScheme = await response.json()
			await this.loadControlScheme(controlScheme)
		} catch (error) {
			console.error('Error loading default control scheme:', error)
			throw error
		}
	}

	normalizeControlScheme(controlScheme) {
		return {
			...controlScheme,
			bindings: controlScheme.bindings.map(this.normalizeBinding),
		}
	}

	normalizeBinding(binding) {
		return {
			...binding,
			input: Array.isArray(binding.input) ? binding.input.map(i => i.toLowerCase()) : binding.input.toLowerCase(),
		}
	}

	validateControlScheme(controlScheme) {
		if (!controlScheme.name || !controlScheme.description || !controlScheme.bindings) {
			return false
		}
		for (const binding of controlScheme.bindings) {
			if (!binding.action || !binding.input || !binding.type || !binding.displayName) {
				return false
			}
			if (binding.type === 'sequence' && !Array.isArray(binding.input)) {
				return false
			}
		}
		return true
	}
}
