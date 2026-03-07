const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs, layerManager, gameManager } = engine.getManagers()

const { lerp } = await import(`${PATH_CORE}/utils/lerp.js`)

const { playerTag, position } = ecs.getTypeIDs()

//! Going to need culling.

export class CameraSystem {
	async init() {
		this.playerQuery = this.getQuery({
			with: [playerTag, position],
		})

		this.playerId = null

		this.starfieldSprite = null

		this.camera = { x: 0, y: 0 }

		this.smoothingFactorX = 3.0
		this.smoothingFactorY = 3.0

		this.screenWidth = gameManager.getApp().screen.width
		this.screenHeight = gameManager.getApp().screen.height

		findPlayer: for (const chunk of this.playerQuery.iter()) {
			const positionArrays = chunk.componentData[position]
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

				// Get a reference to the background sprite.
				this.starfieldSprite = layerManager.get('starfieldSprite')
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

	update({ deltaTime, currentTick }) {
		this.screenWidth = gameManager.getApp().screen.width
		this.screenHeight = gameManager.getApp().screen.height

		if (!this.playerId) return

		// By iterating the query, we follow the standard, efficient system pattern.
		// For a singleton entity like the player, this loop will only run once.
		for (const chunk of this.playerQuery.iter()) {
			const positionArrays = chunk.componentData[position]

			// We can assume the first entity in the first chunk is our player.
			const indexInChunk = 0

			const playerPosition = {
				x: positionArrays.x[indexInChunk],
				y: positionArrays.y[indexInChunk],
			}

			const { desiredX, desiredY } = this.calculateTargetPosition(playerPosition)
			this.camera.x = lerp(this.camera.x, desiredX, this.smoothingFactorX * deltaTime)
			this.camera.y = lerp(this.camera.y, desiredY, this.smoothingFactorY * deltaTime)

			// Update the tiling background position to create the illusion of movement.
			if (this.starfieldSprite) {
				// --- Background Scrolling Logic ---
				// The `tilePosition` property of a PIXI.TilingSprite controls the texture's offset.
				// To create the illusion of moving through an infinite space, we tie this offset
				// directly to the camera's logical position.

				// `this.camera.x` tracks the player's world X position.
				// `this.camera.y` tracks the player's *inverted* world Y position (-player.y).

				// By setting the tilePosition to the negative of the camera's coordinates, we
				// ensure the background texture scrolls correctly with the player's movement.
				// While seemingly counter-intuitive, this produces the desired visual effect.
				this.starfieldSprite.tilePosition.x = -this.camera.x
				this.starfieldSprite.tilePosition.y = -this.camera.y
			}

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
		// Invert the Y-axis. The game world uses a Y-Up coordinate system (like in math),
		// but the rendering/screen space uses a Y-Down system. The camera's internal `y`
		// stores the inverted value to make calculations for screen-space objects easier.
		const desiredY = -playerPosition.y
		return { desiredX, desiredY }
	}
}
