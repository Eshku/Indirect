const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, layerManager, gameManager, archetypeManager, entityManager } =
	theManager.getManagers()
const { lerp } = await import(`${PATH_CORE}/utils/lerp.js`)
/* const { Archetype } = await import(`${PATH_MANAGERS}/ArchetypeManager/Archetype.js`) */

const { PlayerTag, Position } = componentManager.getComponents()

export class CameraSystem {
	constructor() {
		// A simple, non-reactive query to find the player entity.
		// We need to check the player's position every frame to smoothly follow it,
		// so a reactive query isn't suitable here.
		this.playerQuery = queryManager.getQuery({
			with: [PlayerTag, Position],
		})

		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.playerId = null // Cache the player's entity ID

		// The camera's logical world position. This is the point the camera looks at.
		this.camera = { x: 0, y: 0 }
		// Conceptual future stuffs:
		// this.targetMode = `Idle`
		// this.targetZoom = 1
		// this.targetLookAhead = { x: 0, y: 0 }

		//  Configurable Parameters from Camera Concept

		// Smoothing factors for camera movement. Higher values mean faster movement.
		this.smoothingFactorX = 3.0 // Higher value = faster/less smooth
		this.smoothingFactorY = 3.0 // Higher value = faster/less smooth

		// We still need screen dimensions to center the world correctly.
		this.screenWidth = gameManager.getApp().screen.width
		this.screenHeight = gameManager.getApp().screen.height
	}

	async init() {
		// To find the player for the initial camera snap, we iterate our query once.
		// This is a standard and efficient ECS pattern for one-time lookups,
		// especially for singleton-like entities (e.g., the player).
		// Since this query is non-reactive, calling the standard `iter()` method
		// will correctly iterate over all matching entities for this one-time setup.
		for (const chunk of this.playerQuery.iter()) {
			const archetype = chunk.archetype
			const positionArrays = archetype.componentArrays[this.positionTypeID]
			const posX = positionArrays.x
			const posY = positionArrays.y
			for (const entityIndex of chunk) {
				this.playerId = archetype.entities[entityIndex] // Cache the ID
				const initialPosition = { x: posX[entityIndex], y: posY[entityIndex] }

				// Snap the camera instantly to the initial target position on startup.
				const { desiredX, desiredY } = this.calculateTargetPosition(initialPosition)
				this.camera.x = desiredX
				this.camera.y = desiredY

				// Apply the position immediately so there's no one-frame lag.
				const gameContainer = layerManager.getLayer('gameContainer')
				if (gameContainer) {
					gameContainer.x = Math.round(-this.camera.x + this.screenWidth / 2)
					gameContainer.y = Math.round(-this.camera.y + this.screenHeight / 2)
				}
				// Found the player, and there's nothing else to do in init.
				return
			}
		}
	}

	_findPlayer() {
		// This loop is very fast as the query is cached and there's only one player.
		for (const chunk of this.playerQuery.iter()) {
			const archetype = chunk.archetype
			for (const entityIndex of chunk) {
				this.playerId = archetype.entities[entityIndex]
				return true // Found the player
			}
		}
		this.playerId = null // Player not found
		return false
	}

	update(deltaTime, currentTick) {
		// Update screen dimensions in case of resize.
		this.screenWidth = gameManager.getApp().screen.width
		this.screenHeight = gameManager.getApp().screen.height

		const archetypeId = entityManager.entityArchetype[this.playerId]
		const entityIndex = entityManager.entityIndexInArchetype[this.playerId]

		const archetype = archetypeManager.getData(archetypeId)
		const positionArrays = archetype.componentArrays[this.positionTypeID]

		const playerPosition = {
			x: positionArrays.x[entityIndex],
			y: positionArrays.y[entityIndex],
		}

		// 1. Calculate the desired position for the camera based on the player.
		const { desiredX, desiredY } = this.calculateTargetPosition(playerPosition)
		this.camera.x = lerp(this.camera.x, desiredX, this.smoothingFactorX * deltaTime)
		this.camera.y = lerp(this.camera.y, desiredY, this.smoothingFactorY * deltaTime)

		// 3. Apply the camera's position to the main game layer.
		// This moves the entire world, creating the illusion of a camera.
		// We get the root container for all gameplay layers and move it.
		const gameContainer = layerManager.getLayer('gameContainer')
		if (!gameContainer) return
		gameContainer.x = Math.round(-this.camera.x + this.screenWidth / 2)
		gameContainer.y = Math.round(-this.camera.y + this.screenHeight / 2)
	}

	/**
	 * Calculates the target position the camera should move towards.
	 * This includes the player's position and the look-ahead offset.
	 * @returns {{desiredX: number, desiredY: number}} The target coordinates.
	 */
	calculateTargetPosition(playerPosition) {
		// Player's logical position
		const desiredX = playerPosition.x
		// Invert Y for screen coordinates (up is negative in PixiJS)
		const desiredY = -playerPosition.y

		// The camera should target the player's screen position.
		// Since SyncTransforms now uses a direct mapping, the camera's target is (x, -y).
		return { desiredX, desiredY }
	}
}
