const { inputManager, uiManager, gameManager } = (
	await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
).theManager.getManagers()

/**
 * Manages input context by enabling or disabling specific actions based on UI state.
 * For example, it disables the 'MainAttack' action when the mouse is hovering over any UI element,
 * preventing the player from attacking while interacting with the UI.
 */
export class InputContextSystem {
	constructor() {
		/**
		 * Caches the last known state of whether the pointer was over the UI.
		 * This prevents redundant calls to the inputManager every frame.
		 * @private
		 */
		this.isPointerOverUI = false
		/** @private */
		this.pointer = null
	}

	init() {
		// Cache the pointer object on initialization for cleaner access in the update loop.
		this.pointer = gameManager.getApp().renderer.events.pointer
	}

	update() {
		const currentlyOverUI = uiManager.isPointerOverUI(this.pointer.clientX, this.pointer.clientY)
        //probably an overkill, that is not cheap
        //just to ensure we never do hotbar actions \ attacks when hovering over UI
		if (currentlyOverUI !== this.isPointerOverUI) {
			// The context has changed (pointer entered or left a UI element).
			if (currentlyOverUI) {
				inputManager.disableAction('Input MainAttack', 'ui_hover')
			} else {
				inputManager.enableAction('Input MainAttack', 'ui_hover')
			}
			this.isPointerOverUI = currentlyOverUI
		}
	}
}
