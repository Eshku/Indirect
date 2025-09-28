const { eventEmitter } = await import(`${PATH_CORE}/Classes/EventEmitter.js`)

const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs, uiManager } = engine.getManagers()
const { queryManager } = ecs

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

	setupEventListeners() {
		this._setupContinuousActionListeners()
		this._setupHotbarListeners()
	}

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

	_setupHotbarListeners() {
		for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
			const eventSlotNumber = (i + 1) % HOTBAR_SLOT_COUNT
			eventEmitter.on(`Input Hotbar${eventSlotNumber}`, key => {
				if (key.isActive) {
					this.instantActionQueue.push({ type: 'slotChange', value: i })
				}
			})
		}
	}

	update(deltaTime, currentTick) {
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
			const movementIntents = chunk.componentArrays[this.movementIntent]
			const jumps = chunk.componentArrays[this.jump]
			const actionIntents = chunk.componentArrays[this.actionIntent]

			const intentsX = movementIntents.desiredX
			const intentsY = movementIntents.desiredY
			const jumpsWants = jumps.wantsToJump
			const actionsIntent = actionIntents.actionIntent

			const movementMarker = chunk.getDirtyMarker(this.movementIntent, currentTick)
			const jumpMarker = chunk.getDirtyMarker(this.jump, currentTick)
			const actionMarker = chunk.getDirtyMarker(this.actionIntent, currentTick)

			for (let i = 0; i < chunk.size; i++) {
				if (intentsX[i] !== intentX || intentsY[i] !== intentY) {
					intentsX[i] = intentX
					intentsY[i] = intentY
					movementMarker.mark(i)
				}

				if (jumpsWants[i] !== wantsToJump) {
					jumpsWants[i] = wantsToJump
					jumpMarker.mark(i)
				}

				// For continuous actions like holding down an attack button, we always set the intent
				// if the button is pressed. The ItemEventSystem is responsible for consuming
				// this intent (setting it to 0) each tick, allowing this system to re-trigger it on the next tick.
				if (mainAttackIntent === 1) {
					actionsIntent[i] = mainAttackIntent
					actionMarker.mark(i)
				}
			}
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
			const activeSets = chunk.componentArrays[this.activeSet]
			const activeSetMarker = chunk.getDirtyMarker(this.activeSet, currentTick)

			// The player query will only match one entity.
			// We can safely operate on the first entity in the first chunk.
			const indexInChunk = 0
			if (activeSets.activeSlotIndex[indexInChunk] !== slotIndex) {
				activeSets.activeSlotIndex[indexInChunk] = slotIndex
				activeSetMarker.mark(indexInChunk)
			}
		}
	}
}
