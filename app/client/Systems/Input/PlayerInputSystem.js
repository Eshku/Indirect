const { eventEmitter } = await import(`${PATH_CORE}/Classes/EventEmitter.js`)

const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs, uiManager, entityManager } = engine.getManagers()
const { queryManager } = ecs // entityManager is now available at the top level

const { HOTBAR_SLOT_COUNT } = await import(`${PATH_UI}/Hotbar.js`)

/**
 * Handles all player inputs, both continuous (e.g., movement) and instant (e.g., hotbar selection).
 * This system acts as a bridge between the low-level `eventEmitter` and the ECS world.
 * It translates raw input events into component data changes for the player entity.
 */
export class PlayerInputSystem {
	constructor() {
		const { playerTag, movementIntent, jump, actionIntent, activeSet } = ecs.getTypeIDs()
		Object.assign(this, { playerTag, movementIntent, jump, actionIntent, activeSet })

		this.playerQuery = queryManager.getQuery({
			with: [playerTag, movementIntent, jump, actionIntent, activeSet],
		})

		this.inputState = {
			moveLeft: false,
			moveRight: false,
			moveUp: false,
			moveDown: false,
			jump: false,
			mainAttack: false,
		}

		this.instantActionQueue = []
		this.playerId = null
	}

	async init() {



		this.hotbar = uiManager.getElement('Hotbar')

		findPlayer: for (const chunk of this.playerQuery.iter()) {
			for (let i = 0; i < chunk.size; i++) {
				this.playerId = chunk.entities[i]
				break findPlayer
			}
		}

		if (!this.playerId) console.error('PlayerInputSystem: Could not find player entity during initialization.')
		this.setupEventListeners()
	}

	destroy() {
		// Unregister all event listeners to prevent memory leaks on HMR.
		if (this.continuousActionHandlers) {
			for (const [action] of Object.entries(this.continuousActions)) {
				eventEmitter.off(`Input ${action}`, this.continuousActionHandlers[action])
			}
		}
		if (this.hotbarHandlers) {
			for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
				const eventSlotNumber = (i + 1) % HOTBAR_SLOT_COUNT
				eventEmitter.off(`Input Hotbar${eventSlotNumber}`, this.hotbarHandlers[i])
			}
		}
	}

	setupEventListeners() {
		// Cache the handlers so they can be removed correctly in destroy().
		this.continuousActions = {
			Up: 'moveUp',
			Down: 'moveDown',
			Left: 'moveLeft',
			Right: 'moveRight',
			Jump: 'jump',
			MainAttack: 'mainAttack',
		}

		this.continuousActionHandlers = {}
		for (const [action, stateKey] of Object.entries(this.continuousActions)) {
			const handler = event => {
				this.inputState[stateKey] = event.isActive
			}
			this.continuousActionHandlers[action] = handler
			eventEmitter.on(`Input ${action}`, handler)
		}

		this.hotbarHandlers = []
		for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
			const eventSlotNumber = (i + 1) % HOTBAR_SLOT_COUNT
			const handler = key => {
				if (key.isActive) {
					this.instantActionQueue.push({ type: 'slotChange', value: i })
				}
			}
			this.hotbarHandlers[i] = handler
			eventEmitter.on(`Input Hotbar${eventSlotNumber}`, handler)
		}
	}

	update({deltaTime, currentTick}) {
		if (!this.playerId) return

		this._processContinuousInputs(currentTick)
		this._processInstantActions(currentTick)

		if (this.instantActionQueue.length > 0) {
			this.instantActionQueue.length = 0
		}
	}

	_processContinuousInputs(currentTick) {
		const { moveLeft, moveRight, moveUp, moveDown, jump, mainAttack } = this.inputState

		let intentX = 0
		if (moveLeft && !moveRight) intentX = -1
		else if (moveRight && !moveLeft) intentX = 1

		let intentY = 0
		if (moveUp && !moveDown) intentY = 1
		else if (moveDown && !moveUp) intentY = -1

		const length = Math.sqrt(intentX * intentX + intentY * intentY)
		if (length > 0) {
			intentX /= length
			intentY /= length
		}

		const wantsToJump = jump ? 1 : 0
		const mainAttackIntent = mainAttack ? 1 : 0

		for (const chunk of this.playerQuery.iter()) {
			const movementIntents = chunk.componentData[this.movementIntent]
			const jumps = chunk.componentData[this.jump]
			const actionIntents = chunk.componentData[this.actionIntent]

			const intentsX = movementIntents.desiredX
			const intentsY = movementIntents.desiredY
			const jumpsWants = jumps.wantsToJump
			const actionsIntent = actionIntents.actionIntent

			let movementModified = false
			let jumpModified = false
			let actionModified = false

			for (let i = 0; i < chunk.size; i++) {
				if (intentsX[i] !== intentX || intentsY[i] !== intentY) {
					intentsX[i] = intentX
					intentsY[i] = intentY
					chunk.dirtyTicks[this.movementIntent][i] = currentTick
					movementModified = true
				}

				if (jumpsWants[i] !== wantsToJump) {
					jumpsWants[i] = wantsToJump
					chunk.dirtyTicks[this.jump][i] = currentTick
					jumpModified = true
				}

				// For continuous actions like holding down an attack button, we always set the intent
				// if the button is pressed. The ItemEventSystem is responsible for consuming
				// this intent (setting it to 0) each tick, allowing this system to re-trigger it on the next tick.
				if (mainAttackIntent === 1) {
					actionsIntent[i] = mainAttackIntent // This is a direct write, not a toggle
					chunk.dirtyTicks[this.actionIntent][i] = currentTick
					actionModified = true
				}
			}
			if (movementModified) chunk.markChunkDirty(this.movementIntent, currentTick)
			if (jumpModified) chunk.markChunkDirty(this.jump, currentTick)
			if (actionModified) chunk.markChunkDirty(this.actionIntent, currentTick)
		}
	}

	_processInstantActions(currentTick) {
		if (this.instantActionQueue.length === 0) return

		for (const action of this.instantActionQueue) {
			if (action.type === 'slotChange') {
				this._setActiveHotbarSlot(action.value, currentTick)
			}
		}
	}

	_setActiveHotbarSlot(slotIndex, currentTick) {
		for (const chunk of this.playerQuery.iter()) {
			const activeSets = chunk.componentData[this.activeSet]

			// The player query will only match one entity.
			// We can safely operate on the first entity in the first chunk.
			const indexInChunk = 0
			if (activeSets.activeSlotIndex[indexInChunk] !== slotIndex) {
				activeSets.activeSlotIndex[indexInChunk] = slotIndex
				chunk.dirtyTicks[this.activeSet][indexInChunk] = currentTick
				chunk.markChunkDirty(this.activeSet, currentTick)
			}
		}
	}
}
