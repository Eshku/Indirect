const { eventEmitter } = await import(`@core/Classes/EventEmitter.js`)

const { engine } = await import(`@client/Engine.js`)
const { ecs, uiManager } = engine.getManagers()

const { playerTag, movementIntent, shootingIntent } = ecs.getTypeIDs()

/**
 * Handles all player inputs for continuous actions like movement and firing.
 * This system acts as a bridge between the abstract input events and the ECS world.
 * It translates raw input events into component data changes for the player entity.
 */
export class PlayerInputSystem {
	static dependencies = {
		update: {
			reads: [movementIntent],
			writes: [movementIntent, shootingIntent],
		},
	}

	async init() {
		this.playerQuery = this.getQuery({
			with: [playerTag, movementIntent, shootingIntent],
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
			const shootingIntents = chunk.componentData[shootingIntent]

			const intentsX = movementIntents.desiredX
			const intentsY = movementIntents.desiredY
			const actionsIntent = shootingIntents.shootingIntent

			for (let i = 0; i < chunk.size; i++) {
				// Since this is a high-volatility system for a singleton, we can
				// perform an unconditional write to keep the loop branchless and simple.
				intentsX[i] = intentX
				intentsY[i] = intentY
				actionsIntent[i] = mainAttackIntent
			}
		}
	}
}
