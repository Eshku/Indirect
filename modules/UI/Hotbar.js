const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { assetManager } = theManager.getManagers()

export const HOTBAR_SLOT_COUNT = 10
const SLOT_SIZE = 64 // Example size for a slot (width and height)
const SLOT_PADDING = 8 // Padding between slots
const KEYBINDING_FONT_SIZE = 16
const COOLDOWN_FONT_SIZE = 24

export class Hotbar {
	constructor(pixiApp, layer) {
		if (!pixiApp || !layer) {
			console.error('Hotbar: PIXI.Application instance and UI layer are required.')
			return
		}

		this.pixiApp = pixiApp
		this.uiLayer = layer

		// Create shared text styles to avoid creating new ones for each slot.
		this.keybindingTextStyle = new PIXI.TextStyle({
			fontSize: KEYBINDING_FONT_SIZE,
			fill: 0xffffff,
			stroke: 0x000000,
			strokeThickness: 2,
		})
		this.cooldownTextStyle = new PIXI.TextStyle({
			fontSize: COOLDOWN_FONT_SIZE,
			fill: 0xffffff,
			align: 'center',
			stroke: 0x000000,
			strokeThickness: 2,
		})

		this.slots = [] // Array to hold PIXI.Container for each slot
		this.activeSlotIndex = -1 // Track the currently active slot

		this._createHotbarContainer()
		this._createSlots()
		this.onResize() // Initial positioning

		// Listen for resize events
		this.pixiApp.renderer.on('resize', this.onResize, this)
	}

	_createHotbarContainer() {
		this.container = new PIXI.Container()
		this.container.interactive = true
		this.uiLayer.addChild(this.container)
	}

	_createSlots() {
		for (let slotIndex = 0; slotIndex < HOTBAR_SLOT_COUNT; slotIndex++) {
			const slotContainer = new PIXI.Container()
			slotContainer.width = SLOT_SIZE
			slotContainer.height = SLOT_SIZE
			slotContainer.x = slotIndex * (SLOT_SIZE + SLOT_PADDING)
			slotContainer.interactive = true // Make it respond to pointer events
			slotContainer.hitArea = new PIXI.Rectangle(0, 0, SLOT_SIZE, SLOT_SIZE)

			// Background for the slot (e.g., a simple rectangle)
			const background = new PIXI.Graphics()
			background.beginFill(0x333333, 0.8) // The fill
			background.drawRect(0, 0, SLOT_SIZE, SLOT_SIZE) // The shape
			background.endFill()
			slotContainer.addChild(background)

			// Border for the slot, which will also act as the highlight
			const border = new PIXI.Graphics()
			border.beginFill(0, 0) // Set fill to be transparent
			border.lineStyle(2, 0xaaaaaa, 1) // Default inactive border
			border.drawRect(0, 0, SLOT_SIZE, SLOT_SIZE)
			border.endFill()
			slotContainer.addChild(border)

			// Icon placeholder
			const icon = new PIXI.Sprite()
			icon.width = SLOT_SIZE
			icon.height = SLOT_SIZE
			slotContainer.addChild(icon)

			// Cooldown overlay (initially hidden). Using a tinted Sprite is more performant
			// than redrawing a Graphics object every frame.
			const cooldownOverlay = new PIXI.Sprite(PIXI.Texture.WHITE)
			cooldownOverlay.width = SLOT_SIZE
			cooldownOverlay.tint = 0x000000
			cooldownOverlay.alpha = 0.7
			cooldownOverlay.visible = false
			slotContainer.addChild(cooldownOverlay)

			// Cooldown text (initially hidden)
			const cooldownText = new PIXI.Text('', this.cooldownTextStyle)
			cooldownText.anchor.set(0.5)
			cooldownText.x = SLOT_SIZE / 2
			cooldownText.y = SLOT_SIZE / 2
			cooldownText.visible = false // Hidden by default
			slotContainer.addChild(cooldownText)

			// Keybinding text (bottom right)
			const keybindingText = new PIXI.Text(String((slotIndex + 1) % 10), this.keybindingTextStyle)
			keybindingText.anchor.set(1, 1) // Anchor to bottom-right
			keybindingText.x = SLOT_SIZE - 2 // Small padding from right edge
			keybindingText.y = SLOT_SIZE - 2 // Small padding from bottom edge
			slotContainer.addChild(keybindingText)

			this.slots.push({
				container: slotContainer,
				background: background,
				border: border,
				icon: icon,
				cooldownOverlay: cooldownOverlay,
				cooldownText: cooldownText,
				keybindingText: keybindingText,
				itemId: null, // Store the entity ID of the item in the slot
				// Store original keybinding for potential future updates
				originalKeybinding: String((slotIndex + 1) % 10),
			})
			this.container.addChild(slotContainer)
		}
	}

	onResize() {
		const totalWidth = HOTBAR_SLOT_COUNT * SLOT_SIZE + (HOTBAR_SLOT_COUNT - 1) * SLOT_PADDING
		this.container.x = (this.pixiApp.screen.width - totalWidth) / 2
		this.container.y = this.pixiApp.screen.height - SLOT_SIZE - SLOT_PADDING * 2 // Near bottom
	}

	/**
	 * Determines which hotbar slot is at a given screen position.
	 * @param {PIXI.PointData} position - The screen coordinates (e.g., from the mouse pointer).
	 * @returns {number|null} The index of the slot, or null if no slot is at that position.
	 */
	getSlotIndexAt(position) {
		for (let slotIndex = 0; slotIndex < this.slots.length; slotIndex++) {
			const slot = this.slots[slotIndex]
			// Get the global bounds of the slot container
			const bounds = slot.container.getBounds()

			if (bounds.containsPoint(position.x, position.y)) {
				return slotIndex
			}
		}
		return null
	}

	/**
	 * Sets the content for a slot based on an item's entity ID.
	 * @param {number} slotIndex - The index of the slot (0-9).
	 * @param {object} content - The content to display.
	 * @param {number|null} content.itemId - The entity ID of the item, for tooltips.
	 * @param {string|null} content.iconAsset - The asset name for the icon.
	 */
	setSlotContent(slotIndex, { itemId, iconAsset }) {
		if (slotIndex < 0 || slotIndex >= HOTBAR_SLOT_COUNT) {
			console.warn(`Hotbar: Invalid slot index ${slotIndex}.`)
			return
		}
		const slot = this.slots[slotIndex]
		slot.itemId = itemId

		if (iconAsset) {
			const texture = assetManager.getAsset(iconAsset)
			if (texture) {
				slot.icon.texture = texture
				slot.icon.visible = true
			} else {
				console.warn(`Hotbar: Texture for asset "${iconAsset}" not found.`)
				slot.icon.visible = false
			}
		} else {
			// Slot is empty
			slot.icon.visible = false
		}

		// Ensure cooldown is hidden when content is reset
		slot.cooldownOverlay.visible = false
		slot.cooldownText.visible = false
	}

	/**
	 * Updates only the cooldown display for a specific slot. Call this every frame for active cooldowns.
	 * @param {number} slotIndex - The index of the slot (0-9).
	 * @param {object|null} cooldownData - The Cooldown component data.
	 */
	updateCooldown(slotIndex, cooldownData) {
		if (slotIndex < 0 || slotIndex >= HOTBAR_SLOT_COUNT) return
		const slot = this.slots[slotIndex]

		if (cooldownData && cooldownData.remainingTime > 0) {
			slot.cooldownOverlay.visible = true
			slot.cooldownText.visible = true

			// Update the height of the sprite for the overlay effect.
			const progress = cooldownData.remainingTime / cooldownData.totalDuration
			slot.cooldownOverlay.height = SLOT_SIZE * progress

			// Update cooldown text to always show one decimal place and an 's' for seconds.
			// This allows the user to see sub-second changes clearly.
			slot.cooldownText.text = `${cooldownData.remainingTime.toFixed(1)}s`
		} else {
			slot.cooldownOverlay.visible = false
			slot.cooldownText.visible = false
		}
	}

	/**
	 * Activates the highlight for a specific slot, indicating it's the active one.
	 * @param {number} slotIndex - The index of the slot (0-9) to activate.
	 */
	activateSlot(slotIndex) {
		if (slotIndex < 0 || slotIndex >= HOTBAR_SLOT_COUNT) return
		const slot = this.slots[slotIndex]

		// Only redraw the border, not the background fill, for better performance.
		slot.border.clear()
		slot.border.beginFill(0, 0) // Set fill to be transparent
		slot.border.lineStyle(4, 0xffff00, 1) // Active: thicker, yellow
		slot.border.drawRect(0, 0, SLOT_SIZE, SLOT_SIZE)
		slot.border.endFill()

		this.activeSlotIndex = slotIndex
	}

	/**
	 * Deactivates the highlight for a specific slot.
	 * @param {number} slotIndex - The index of the slot (0-9) to deactivate.
	 */
	deactivateSlot(slotIndex) {
		if (slotIndex < 0 || slotIndex >= HOTBAR_SLOT_COUNT) return
		const slot = this.slots[slotIndex]

		slot.border.clear()
		slot.border.beginFill(0, 0) // Set fill to be transparent
		slot.border.lineStyle(2, 0xaaaaaa, 1) // Inactive: normal
		slot.border.drawRect(0, 0, SLOT_SIZE, SLOT_SIZE)
		slot.border.endFill()

		if (this.activeSlotIndex === slotIndex) {
			this.activeSlotIndex = -1
		}
	}

	/**
	 * Swaps the active slot from the current one to a new one.
	 * @param {number} newSlotIndex - The index of the slot to make active.
	 */
	swapSlot(newSlotIndex) {
		if (newSlotIndex < 0 || newSlotIndex >= HOTBAR_SLOT_COUNT) {
			return
		}
		if (newSlotIndex === this.activeSlotIndex) {
			return // No change needed
		}

		// Deactivate the current slot if one is active
		if (this.activeSlotIndex !== -1) {
			this.deactivateSlot(this.activeSlotIndex)
		}

		// Activate the new slot
		this.activateSlot(newSlotIndex)
	}

	/**
	 * Sets the keybinding text for a specific slot.
	 * @param {number} slotIndex - The index of the slot (0-9).
	 * @param {string} key - The keybinding string (e.g., "1", "Q").
	 */
	setKeyVisuals(slotIndex, key) {
		if (slotIndex >= 0 && slotIndex < HOTBAR_SLOT_COUNT) {
			this.slots[slotIndex].keybindingText.text = key
		}
	}

	getInteractiveBounds() {
		return this.container.getBounds()
	}

	/**
	 * Shows the hotbar.
	 */
	show() {
		this.container.visible = true
	}

	/**
	 * Hides the hotbar.
	 */
	hide() {
		if (this.container) {
			this.container.visible = false
		}
	}

	/**
	 * Cleans up the hotbar, removing it from the stage and removing event listeners.
	 */
	destroy() {
		// The UIInteractionSystem is responsible for its own event listeners,
		// but we should ensure the container is cleaned up properly.
		this.container?.off('pointermove')
		this.container?.off('pointerleave')
		if (this.pixiApp) {
			this.pixiApp.renderer.off('resize', this.onResize, this)
		}
		if (this.container) {
			this.uiLayer.removeChild(this.container)
			this.container.destroy({ children: true })
			this.container = null
		}
	}
}
