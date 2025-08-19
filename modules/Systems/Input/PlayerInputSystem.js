const { eventEmitter } = await import(`${PATH_CORE}/Classes/EventEmitter.js`)

const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)

const { queryManager, componentManager, uiManager, archetypeManager } = theManager.getManagers()

const { HOTBAR_SLOT_COUNT } = await import(`${PATH_UI}/Hotbar.js`)

const { PlayerTag, MovementIntent, Jump, ActionIntent, ActiveSet } = componentManager.getComponents()

/**
 * Handles all player inputs, both continuous (e.g., movement) and instant (e.g., hotbar selection).
 * This system acts as a bridge between the low-level `eventEmitter` and the ECS world.
 * - It listens for raw input events.
 * - It updates "intent" components on the player entity (`MovementIntent`, `ActionIntent`, `Jump`).
 * - It queues commands for one-shot actions like changing the active hotbar slot.
 * This system translates raw input events into component data changes for the player entity.
 */
export class PlayerInputSystem {
	constructor() {
		// Query for the player entity to apply continuous inputs like movement.
		this.playerQuery = queryManager.getQuery({
			// This query now also gets the ActiveSet for modification.
			with: [PlayerTag, MovementIntent, Jump, ActionIntent, ActiveSet],
		})

		// Cache component Type IDs for performance.
		this.movementIntentTypeID = componentManager.getComponentTypeID(MovementIntent)
		this.jumpTypeID = componentManager.getComponentTypeID(Jump)
		this.actionIntentTypeID = componentManager.getComponentTypeID(ActionIntent)
		this.activeSetTypeID = componentManager.getComponentTypeID(ActiveSet)

		// State for continuous inputs, updated by events.
		this.inputState = {
			moveLeft: false,
			moveRight: false,
			moveUp: false,
			moveDown: false,
			jump: false,
			mainAttack: false,
		}

		// A queue for instant, one-off actions to be processed in the update loop.
		this.instantActionQueue = []

		// The entity ID of the player, cached for quick access.
		this.playerId = null
	}

	init() {
		this.hotbar = uiManager.getElement('Hotbar')

		// Find and cache the player's entity ID for quick access.

		findPlayer: for (const chunk of this.playerQuery.iter()) {
			// This query will only find one entity, so we can break after the first.
			for (const entityIndex of chunk) {
				this.playerId = chunk.archetype.entities[entityIndex]
				break findPlayer
			}
		}

		if (!this.playerId) console.error('PlayerInputSystem: Could not find player entity during initialization.')
		this.setupEventListeners()
	}

	/**
	 * Sets up event listeners for all player-related inputs.
	 * This method maps input events to state changes within the system.
	 */
	setupEventListeners() {
		this._setupContinuousActionListeners()
		this._setupHotbarListeners()
	}

	/**
	 * Sets up listeners for continuous actions like movement and attacking.
	 * These actions update a state object that is polled every frame.
	 * @private
	 */
	_setupContinuousActionListeners() {
		const continuousActions = {
			Up: 'moveUp',
			Down: 'moveDown',
			Left: 'moveLeft',
			Right: 'moveRight',
			Jump: 'jump',
			MainAttack: 'mainAttack',
		}

		for (const [action, stateKey] of Object.entries(continuousActions)) {
			eventEmitter.on(`Input ${action}`, event => {
				this.inputState[stateKey] = event.isActive
			})
		}
	}

	/**
	 * Sets up listeners for instant actions like selecting a hotbar slot.
	 * These actions are pushed to a queue to be processed once per frame.
	 * @private
	 */
	_setupHotbarListeners() {
		for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
			// Map hotbar keys (1-9, 0) to slot indices (0-9).
			// The event for key '1' is 'Input Hotbar1', for '9' is 'Input Hotbar9', and for '0' is 'Input Hotbar0'.
			const eventSlotNumber = (i + 1) % HOTBAR_SLOT_COUNT // This handles slot index 9 (the 10th slot) mapping to event 'Hotbar0'.
			eventEmitter.on(`Input Hotbar${eventSlotNumber}`, key => {
				if (key.isActive) {
					this.instantActionQueue.push({ type: 'slotChange', value: i })
				}
			})
		}
	}

	/**
	 * The main update loop. Orchestrates the processing of different input types.
	 * @param {number} currentTick - The current frame tick, used to mark components as dirty.
	 */
	update(deltaTime, currentTick) {
		// No player, no input to process.
		if (!this.playerId) return

		this._processContinuousInputs(currentTick)
		this._processInstantActions()

		// Clear the queue after processing all actions for the frame.
		if (this.instantActionQueue.length > 0) {
			this.instantActionQueue.length = 0
		}
	}

	/**
	 * Reads the continuous input state (e.g., movement keys held down) and updates
	 * the corresponding intent components on the player entity.
	 * @param {number} currentTick - The current tick for marking components as dirty.
	 * @private
	 */
	_processContinuousInputs(currentTick) {
		const { moveLeft, moveRight, moveUp, moveDown, jump, mainAttack } = this.inputState

		let intentX = 0
		if (moveLeft && !moveRight) intentX = -1
		else if (moveRight && !moveLeft) intentX = 1

		let intentY = 0
		if (moveUp && !moveDown) intentY = 1
		else if (moveDown && !moveUp) intentY = -1

		// Normalize the movement vector to prevent faster diagonal movement.
		const length = Math.sqrt(intentX * intentX + intentY * intentY)
		if (length > 0) {
			intentX /= length
			intentY /= length
		}

		const wantsToJump = jump ? 1 : 0
		const mainAttackIntent = mainAttack ? 1 : 0

		// This query should only find the single player entity.
		for (const chunk of this.playerQuery.iter()) {
			const archetypeData = chunk.archetype

			// Get component arrays directly for high-performance access.
			const movementIntents = archetypeData.componentArrays[this.movementIntentTypeID]
			const jumps = archetypeData.componentArrays[this.jumpTypeID]
			const actionIntents = archetypeData.componentArrays[this.actionIntentTypeID]

			// Hoist property access out of the loop for JIT optimization.
			const intentsX = movementIntents.desiredX
			const intentsY = movementIntents.desiredY
			const jumpsWants = jumps.wantsToJump
			const actionsIntent = actionIntents.actionIntent // This is a TypedArray of 0s and 1s

			// Get pre-initialized, cached dirty markers for this archetype.
			const movementMarker = archetypeManager.getDirtyMarker(archetypeData.id, this.movementIntentTypeID, currentTick)
			const jumpMarker = archetypeManager.getDirtyMarker(archetypeData.id, this.jumpTypeID, currentTick)
			const actionMarker = archetypeManager.getDirtyMarker(archetypeData.id, this.actionIntentTypeID, currentTick)

			for (const entityIndex of chunk) {
				// --- Update Continuous Components ---
				if (intentsX[entityIndex] !== intentX || intentsY[entityIndex] !== intentY) {
					intentsX[entityIndex] = intentX
					intentsY[entityIndex] = intentY
					movementMarker.mark(entityIndex)
				}

				if (jumpsWants[entityIndex] !== wantsToJump) {
					jumpsWants[entityIndex] = wantsToJump
					jumpMarker.mark(entityIndex)
				}

				if (actionsIntent[entityIndex] !== mainAttackIntent) {
					actionsIntent[entityIndex] = mainAttackIntent
					actionMarker.mark(entityIndex)
				}
			}
		}
	}

	/**
	 * Processes all queued one-shot actions, like changing the active hotbar slot.
	 * @private
	 */
	_processInstantActions() {
		if (this.instantActionQueue.length === 0) return

		for (const action of this.instantActionQueue) {
			if (action.type === 'slotChange') {
				this._setActiveHotbarSlot(action.value)
			}
		}
	}

	/**
	 * Handles the logic for changing the player's active item.
	 * It finds the current and target items and issues commands to the CommandBuffer
	 * to swap the `IsActive` component.
	 * @param {number} slotIndex - The 0-based index of the hotbar slot to activate.
	 * @private
	 */ _setActiveHotbarSlot(slotIndex) {
		// This is a singleton query, it will only find the player.
		for (const chunk of this.playerQuery.iter()) {
			// Get the SoA data for the ActiveSet component.
			const activeSets = chunk.archetype.componentArrays[this.activeSetTypeID]

			for (const entityIndex of chunk) {
				const currentActiveSlot = activeSets.activeSlotIndex[entityIndex]

				// If the player presses the key for the already active slot, we treat it
				// as a desire to unequip, setting the active slot to -1.
				const newActiveSlot = currentActiveSlot === slotIndex ? -1 : slotIndex

				// Issue a single, non-structural data update command. This is extremely
				// performant for "hot" components.
				this.commands.setComponentData(this.playerId, this.activeSetTypeID, { activeSlotIndex: newActiveSlot })

				// Since there's only one player, we can exit immediately.
				return
			}
		}
	}
}
