/**
 * Manages UI elements that can be interacted with, for effects like hovering.
 */
export class UiManager {
	constructor() {
		/**
		 * A list of UI elements that can be checked for interaction.
		 * Each element should have a `getInteractiveBounds()` method.
		 * @type {Array<object>}
		 */
		this.interactiveElements = []

		/**
		 * A map of all registered UI elements, keyed by their class name.
		 * Allows for easy retrieval of specific UI components.
		 * @type {Map<string, object>}
		 */
		this.registeredElements = new Map()
	}

	async init() {}
	/**
	 * Registers a UI element to be tracked by the manager.
	 *
	 * All registered elements can be retrieved by their class name using `getElement()`.
	 * If an element has a `getInteractiveBounds()` method, it will also be added to a separate
	 * list for interaction checks (e.g., hover detection by `getHoveredElement()`).
	 * @param {object} element - The UI element instance to register.
	 * @param {string} [name] - An optional unique name to register the element under. If not provided, the element's constructor name will be used.
	 * @returns {object|null} The registered element, or null if registration failed.
	 */
	register(element, name) {
		if (!element || !element.constructor) return null

		const key = name || element.constructor.name
		if (this.registeredElements.has(key)) {
			console.warn(`UiManager: An element with the name '${key}' is already registered.`)
			return null
		}
		this.registeredElements.set(key, element)

		// If the element is interactive, add it to the interactive list as well.
		if (typeof element.getInteractiveBounds === 'function' && !this.interactiveElements.includes(element)) {
			this.interactiveElements.push(element)
		}

		return element
	}

	/**
	 * Unregisters a UI element.
	 * @param {object} element - The UI element to unregister.
	 */
	unregister(element) {
		if (!element) return

		// Find the key associated with the element instance to remove it from the map.
		let keyToDelete = null
		for (const [key, value] of this.registeredElements.entries()) {
			if (value === element) {
				keyToDelete = key
				break
			}
		}

		if (keyToDelete) this.registeredElements.delete(keyToDelete)

		const index = this.interactiveElements.indexOf(element)
		if (index > -1) {
			this.interactiveElements.splice(index, 1)
		}
	}

	/**
	 * Retrieves a registered UI element by its class name.
	 * @param {string} name - The class name of the UI element to retrieve.
	 * @returns {object|null} The UI element, or null if not found.
	 */
	getElement(name) {
		return this.registeredElements.get(name) || null
	}

	/**
	 * Checks which UI element, if any, is being hovered by the pointer.
	 * @param {object} point - The pointer coordinates (e.g., { x, y }).
	 * @returns {object|null} The UI element being hovered, or null if none.
	 */
	getHoveredElement(point) {
		for (let i = this.interactiveElements.length - 1; i >= 0; i--) {
			const uiElement = this.interactiveElements[i]

			if (uiElement.container?.visible && typeof uiElement.getInteractiveBounds === 'function') {
				if (uiElement.getInteractiveBounds().containsPoint(point.x, point.y)) {
					return uiElement
				}
			}
		}

		return null
	}

	/**
	 * Checks if the pointer is currently over any visible, interactive UI element.
	 * This is used by the InputManager to prevent gameplay actions (like attacks)
	 * when the user is clicking on the UI.
	 *
	 * The current implementation treats the entire bounding box of a UI element as interactive.
	 * A future improvement could be to check against the actual visible parts of the UI,
	 * which would be useful for UI with complex shapes or transparent areas.
	 * @param {number} x - The x-coordinate of the pointer (e.g., from event.clientX).
	 * @param {number} y - The y-coordinate of the pointer (e.g., from event.clientY).
	 * @returns {boolean} True if the pointer is over any interactive UI element, false otherwise.
	 */
	isPointerOverUI(x, y) {
		// Iterate backwards to check top-most elements first.
		for (let i = this.interactiveElements.length - 1; i >= 0; i--) {
			const uiElement = this.interactiveElements[i]

			// A UI element is considered for pointer events if it's visible and has defined interactive bounds.
			if (uiElement.container?.visible && typeof uiElement.getInteractiveBounds === 'function') {
				if (uiElement.getInteractiveBounds().containsPoint(x, y)) {
					return true // Found an interactive element under the pointer.
				}
			}
		}

		return false // No interactive UI element found
	}

	/**
	 * Toggles the visibility of a registered UI element.
	 * @param {string} name - The name of the UI element to toggle.
	 * @returns {boolean | undefined} The new visibility state, or undefined if the element is not found or has no container.
	 */
	toggle(name) {
		const element = this.getElement(name)
		if (element && element.container) {
			element.container.visible = !element.container.visible
			return element.container.visible
		}
		console.warn(`UiManager: Cannot toggle element '${name}'. Not found or has no container.`)
		return undefined
	}
	/**
	 * Returns the list of registered interactive UI elements.
	 * @returns {Array<object>} The list of elements.
	 */
	getInteractiveElements() {
		return this.interactiveElements
	}
}

export const uiManager = new UiManager()
