const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, layerManager, gameManager, entityManager } =
	theManager.getManagers()
const { lerp } = await import(`${PATH_CORE}/utils/lerp.js`)

const { PlayerTag, Position } = componentManager.getComponents()

export class CameraSystem {
	constructor() {
		this.playerQuery = queryManager.getQuery({
			with: [PlayerTag, Position],
		})

		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.playerId = null

		this.camera = { x: 0, y: 0 }

		this.smoothingFactorX = 3.0
		this.smoothingFactorY = 3.0

		this.screenWidth = gameManager.getApp().screen.width
		this.screenHeight = gameManager.getApp().screen.height
	}

	async init() {
		findPlayer: for (const chunk of this.playerQuery.iter()) {
			const positionArrays = chunk.componentArrays[this.positionTypeID]
			const posX = positionArrays.x
			const posY = positionArrays.y
			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				this.playerId = chunk.entities[indexInChunk]
				const initialPosition = { x: posX[indexInChunk], y: posY[indexInChunk] }

				const { desiredX, desiredY } = this.calculateTargetPosition(initialPosition)
				this.camera.x = desiredX
				this.camera.y = desiredY

				const gameContainer = layerManager.getLayer('gameContainer')
				if (gameContainer) {
					gameContainer.x = Math.round(-this.camera.x + this.screenWidth / 2)
					gameContainer.y = Math.round(-this.camera.y + this.screenHeight / 2)
				}
				return
			}
		}
	}

	_findPlayer() {
		for (const chunk of this.playerQuery.iter()) {
			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				this.playerId = chunk.entities[indexInChunk]
				return true
			}
		}
		this.playerId = null
		return false
	}

	update(deltaTime, currentTick) {
		this.screenWidth = gameManager.getApp().screen.width
		this.screenHeight = gameManager.getApp().screen.height

		if (!this.playerId) return

		// By iterating the query, we follow the standard, efficient system pattern.
		// For a singleton entity like the player, this loop will only run once.
		for (const chunk of this.playerQuery.iter()) {
			const positionArrays = chunk.componentArrays[this.positionTypeID]

			// We can assume the first entity in the first chunk is our player.
			const indexInChunk = 0

			const playerPosition = {
				x: positionArrays.x[indexInChunk],
				y: positionArrays.y[indexInChunk],
			}

			const { desiredX, desiredY } = this.calculateTargetPosition(playerPosition)
			this.camera.x = lerp(this.camera.x, desiredX, this.smoothingFactorX * deltaTime)
			this.camera.y = lerp(this.camera.y, desiredY, this.smoothingFactorY * deltaTime)

			const gameContainer = layerManager.getLayer('gameContainer')
			if (!gameContainer) return

			gameContainer.x = Math.round(-this.camera.x + this.screenWidth / 2)
			gameContainer.y = Math.round(-this.camera.y + this.screenHeight / 2)

			// Since we found and processed the player, we can exit.
			return
		}
	}

	calculateTargetPosition(playerPosition) {
		const desiredX = playerPosition.x
		const desiredY = -playerPosition.y
		return { desiredX, desiredY }
	}
}