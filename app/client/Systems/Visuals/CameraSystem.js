const { engine } = await import(`@client/Engine.js`)
const { ecs, layerManager, gameManager } = engine.getManagers()

const { playerTag, position } = ecs.getComponentIDs()
const { SyncTransforms } = ecs.getSystemIDs()

//! Going to need culling.

export class CameraSystem {
	// The camera moves the entire game container, so it must run AFTER all entities within it have been positioned.
	static runsAfter = [SyncTransforms]

	async init() {
		this.playerQuery = this.getQuery({
			with: [playerTag, position],
		})

		this.starfieldSprite = null
		this.camera = { x: 0, y: 0 }

		this.screenWidth = gameManager.getApp().screen.width
		this.screenHeight = gameManager.getApp().screen.height

		let initialPosition = { x: 0, y: 0 }
		const playerChunkIds = this.playerQuery.getChunks()
		if (playerChunkIds.length > 0) {
			const playerChunkId = playerChunkIds[0]
			const positionArrays = this.getComponentData(playerChunkId, position)
			initialPosition = { x: positionArrays.x[0], y: positionArrays.y[0] }
		}

		const { desiredX, desiredY } = this.calculateTargetPosition(initialPosition)
		this.camera.x = desiredX
		this.camera.y = desiredY

		const gameContainer = layerManager.getLayer('gameContainer')

		gameContainer.x = Math.round(-this.camera.x + this.screenWidth / 2)
		gameContainer.y = Math.round(-this.camera.y + this.screenHeight / 2)

		// Get a reference to the background sprite.
		this.starfieldSprite = layerManager.get('starfieldSprite')
	}

	update({ deltaTime, currentTick }) {
		this.screenWidth = gameManager.getApp().screen.width
		this.screenHeight = gameManager.getApp().screen.height
		let playerPosition = { x: 0, y: 0 }

		const playerChunkIds = this.playerQuery.getChunks()
		if (playerChunkIds.length > 0) {
			const playerChunkId = playerChunkIds[0]
			const positionArrays = this.getComponentData(playerChunkId, position)
			playerPosition.x = positionArrays.x[0]
			playerPosition.y = positionArrays.y[0]
		}

		const { desiredX, desiredY } = this.calculateTargetPosition(playerPosition)
		this.camera.x = desiredX
		this.camera.y = desiredY

		if (this.starfieldSprite) {
			this.starfieldSprite.tilePosition.x = -this.camera.x
			this.starfieldSprite.tilePosition.y = -this.camera.y
		}

		const gameContainer = layerManager.getLayer('gameContainer')

		gameContainer.x = Math.round(-this.camera.x + this.screenWidth / 2)
		gameContainer.y = Math.round(-this.camera.y + this.screenHeight / 2)
	}

	calculateTargetPosition(playerPosition) {
		const desiredX = playerPosition.x
		// Invert the Y-axis. The game world uses a Y-Up coordinate system,
		// but the rendering/screen space uses a Y-Down system. The camera's internal `y`
		// stores the inverted value to make calculations for screen-space objects easier.
		const desiredY = -playerPosition.y
		return { desiredX, desiredY }
	}
}
