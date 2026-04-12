const { engine } = await import(`@client/Engine.js`)
const { ecs, layerManager, gameManager } = engine.getManagers()

const { playerTag, position } = ecs.getComponentIDs()
const { SyncTransforms } = ecs.getSystemIDs()

const { eventEmitter } = await import(`@core/Classes/EventEmitter.js`)
//! redo controls properly at some point? 

//! Going to need culling.

export class CameraSystem {
	// The camera moves the entire game container, so it must run AFTER all entities within it have been positioned.
	static runsAfter = [SyncTransforms]

	async init() {
		this.playerQuery = this.getQuery({
			with: [playerTag, position],
		})

		this.starfieldSprite = null

		this.camera = { x: 0, y: 0, zoom: 1.0 }

		// Zoom configuration.
		// A smaller zoom value means the camera is further out.
		// A larger zoom value means the camera is closer in.
		this.zoomOutLimit = 0.4 // Furthest the camera can be (e.g., 0.4x scale).
		this.zoomInLimit = 1.0 // Closest the camera can be (e.g., 1.0x scale).
		this.zoomSpeed = 0.1

		// Listen for zoom events from the InputManager.
		eventEmitter.on('InputZoom', this.onZoom)

		this.screenWidth = gameManager.getApp().screen.width
		this.screenHeight = gameManager.getApp().screen.height

		const playerChunkIds = this.playerQuery.getChunks()
		const playerChunkId = playerChunkIds[0]
		const positionArrays = this.getComponentData(playerChunkId, position)

		this.camera.x = positionArrays.x[0]
		this.camera.y = -positionArrays.y[0]

		const gameContainer = layerManager.getLayer('gameContainer')
		gameContainer.scale.set(this.camera.zoom)

		gameContainer.x = Math.round(this.screenWidth / 2 - this.camera.x * this.camera.zoom)
		gameContainer.y = Math.round(this.screenHeight / 2 - this.camera.y * this.camera.zoom)

		// Get a reference to the background sprite.
		this.starfieldSprite = layerManager.get('starfieldSprite')
	}

	update({ deltaTime, currentTick }) {
		this.screenWidth = gameManager.getApp().screen.width
		this.screenHeight = gameManager.getApp().screen.height

		const playerChunkIds = this.playerQuery.getChunks()
		//player guarantied to exist
		const playerChunkId = playerChunkIds[0]
		const positionArrays = this.getComponentData(playerChunkId, position)

		this.camera.x = positionArrays.x[0]
		this.camera.y = -positionArrays.y[0]

		if (this.starfieldSprite) {
			const zoom = this.camera.zoom

			this.starfieldSprite.tileScale.set(zoom)

			// This formula scales the background's movement to match the game container's movement.
			// It calculates the screen-space position of the camera's origin and uses that to
			// offset the texture, ensuring the background scrolls perfectly with the foreground.
			// This creates the effect of a distant, static starfield rather than a parallax effect.
			const tilePosX = this.screenWidth / 2 - this.camera.x * zoom
			const tilePosY = this.screenHeight / 2 - this.camera.y * zoom

			this.starfieldSprite.tilePosition.set(tilePosX, tilePosY)
		}

		const gameContainer = layerManager.getLayer('gameContainer')
		gameContainer.scale.set(this.camera.zoom)

		// Container's position is calculated to keep the camera's world point at the center of the screen, adjusted for zoom.
		gameContainer.x = Math.round(this.screenWidth / 2 - this.camera.x * this.camera.zoom) 
		gameContainer.y = Math.round(this.screenHeight / 2 - this.camera.y * this.camera.zoom) 
	}

	// Use an arrow function to automatically bind `this`.
	onZoom = ({ delta }) => {
		// A larger delta (e.g., from a fast scroll) should result in a larger zoom change.
		// We use a multiplier to make the zoom feel more responsive.
		// Positive delta is scroll down (zoom out), negative is scroll up (zoom in).
		const zoomFactor = 1 - (delta / 100) * this.zoomSpeed
		const newZoom = this.camera.zoom * zoomFactor
		this.camera.zoom = Math.max(this.zoomOutLimit, Math.min(this.zoomInLimit, newZoom))
	}

	destroy() {
		// Clean up the event listener on HMR or shutdown.
		eventEmitter.off('InputZoom', this.onZoom)
	}
}
