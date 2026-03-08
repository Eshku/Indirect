const { eventEmitter } = await import(`@core/Classes/EventEmitter.js`)

const { engine } = await import(`@client/Engine.js`)
const { ecs, uiManager } = engine.getManagers()

const { playerTag, movementIntent, actionIntent } = ecs.getTypeIDs()

/**
 * Handles all player inputs for continuous actions like movement and firing.
 * This system acts as a bridge between the abstract input events and the ECS world.
 * It translates raw input events into component data changes for the player entity.
 */
export class PlayerInputSystem {
	static dependencies = {
		update: {
			reads: [movementIntent],
			writes: [movementIntent, actionIntent],
		},
	}

	async init() {
		this.playerQuery = this.getQuery({
			with: [playerTag, movementIntent, actionIntent],
		})

		this.inputState = {
			moveLeft: false,
			moveRight: false,
			moveUp: false,
			moveDown: false,
			mainAttack: false,
		}

		this.playerId = null

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
	}

	setupEventListeners() {
		// Cache the handlers so they can be removed correctly in destroy().
		this.continuousActions = {
			Forward: 'moveUp',
			Backward: 'moveDown',
			Left: 'moveLeft',
			Right: 'moveRight',
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
	}

	update({ deltaTime, currentTick }) {
		if (!this.playerId) return

		this._processContinuousInputs(currentTick)
	}

	_processContinuousInputs(currentTick) {
		const { moveLeft, moveRight, moveUp, moveDown, mainAttack } = this.inputState

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

		const mainAttackIntent = mainAttack ? 1 : 0

		for (const chunk of this.playerQuery.iter()) {
			const movementIntents = chunk.componentData[movementIntent]
			const actionIntents = chunk.componentData[actionIntent]

			const intentsX = movementIntents.desiredX
			const intentsY = movementIntents.desiredY
			const actionsIntent = actionIntents.actionIntent

			let movementModified = false
			let actionModified = false

			for (let i = 0; i < chunk.size; i++) {
				if (intentsX[i] !== intentX || intentsY[i] !== intentY) {
					intentsX[i] = intentX
					intentsY[i] = intentY
					chunk.dirtyTicks[movementIntent][i] = currentTick
					movementModified = true
				}

				// For continuous actions like holding down an attack button, we always set the intent
				// if the button is pressed. The ItemEventSystem is responsible for consuming
				// this intent (setting it to 0) each tick, allowing this system to re-trigger it on the next tick.
				if (mainAttackIntent === 1) {
					actionsIntent[i] = mainAttackIntent // This is a direct write, not a toggle
					chunk.dirtyTicks[actionIntent][i] = currentTick
					actionModified = true
				}
			}
			if (movementModified) chunk.markChunkDirty(movementIntent, currentTick)
			if (actionModified) chunk.markChunkDirty(actionIntent, currentTick)
		}
	}
}
