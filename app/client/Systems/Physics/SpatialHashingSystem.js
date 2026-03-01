const { engine } = await import(`${PATH_CLIENT}/Engine.js`)

const { ecs, physicsManager } = engine.getManagers()
const { queryManager } = ecs
const { SpatialHashGrid, SPATIAL_GRID_CONFIG } = await import(`${PATH_CORE}/DataStructures/SpatialHashGrid.js`)

/**
 * Manages the spatial hash grid on the main thread.
 * This system is responsible for clearing, repositioning (based on player position),
 * and populating the grid with all relevant entities each frame.
 * This prepares the grid for safe, parallel read-only queries by worker threads.
 */
export class SpatialHashingSystem {
	constructor() {
		// Get the main-thread instance of the spatial hash grid API.
		// The SABs are owned by the PhysicsManager.
		const gridSABs = physicsManager.getSpatialHashGridSABs()
		this.grid = new SpatialHashGrid(gridSABs)

		// Query for the player entity to track its position for grid repositioning.
		const { playerTag, position, rotation, circleCollider, boxCollider, orientedBoxCollider } = ecs.getTypeIDs()

		this.playerQuery = queryManager.getQuery({
			with: [playerTag, position],
		})

		// A single, unified query for all collidable entity types.
		// This is more efficient than multiple queries as it reduces loop overhead.
		this.collidablesQuery = queryManager.getQuery({
			with: [position],
			any: [circleCollider, boxCollider, orientedBoxCollider],
		})

		// Cache component type IDs for faster access in the update loop.
		this.positionId = position
		this.rotationId = rotation
		this.circleColliderId = circleCollider
		this.boxColliderId = boxCollider
		this.orientedBoxColliderId = orientedBoxCollider

		// Cache the last known player position.
		this.lastPlayerX = 0
		this.lastPlayerY = 0
	}

	init() {
		// No async init needed for this system.
	}

	update({ currentTick, lastTick }) {
		// --- 1. Clear and Reposition Phase ---

		// This is a simple query that will always find the player.
		for (const chunk of this.playerQuery.iter()) {
			const pos = chunk.componentData[this.positionId]
			if (chunk.size > 0) {
				// We found the player. Update our last known position.
				this.lastPlayerX = pos.x[0]
				this.lastPlayerY = pos.y[0]
				break // Only one player.
			}
		}

		// Use the last known player position for the grid.
		// This ensures the grid logic runs even if the player stands still.
		const { lastPlayerX: playerX, lastPlayerY: playerY } = this

		// This performs the hysteresis check and resets the grid for the new frame.
		this.grid.clearAndReposition(playerX, playerY)

		// --- 2. Populate Phase ---

		// Process all collidable entities in a single, efficient loop.
		for (const chunk of this.collidablesQuery.iter()) {
			const positions = chunk.componentData[this.positionId]
			const entities = chunk.entities

			// These components may or may not exist on the chunk's archetype.
			const circleColliders = chunk.componentData[this.circleColliderId]
			const boxColliders = chunk.componentData[this.boxColliderId]
			const orientedBoxColliders = chunk.componentData[this.orientedBoxColliderId]
			const rotations = chunk.componentData[this.rotationId]

			// OPTIMIZATION: Check component existence once per chunk. Since all entities
			// in a chunk share the same archetype, this branch is perfectly predictable
			// after the first entity, leading to highly efficient processing.
			if (orientedBoxColliders) {
				// --- This chunk contains Oriented Box Colliders ---
				for (let i = 0; i < chunk.size; i++) {
					const entityId = entities[i]
					const x = positions.x[i]
					const y = positions.y[i]
					const angle = rotations.angle[i]
					const halfWidth = orientedBoxColliders.width[i] / 2
					const halfHeight = orientedBoxColliders.height[i] / 2

					const c = Math.abs(Math.cos(angle))
					const s = Math.abs(Math.sin(angle))
					const worldHalfWidth = halfWidth * c + halfHeight * s
					const worldHalfHeight = halfWidth * s + halfHeight * c

					const minX = x - worldHalfWidth
					const minY = y - worldHalfHeight
					const maxX = minX + worldHalfWidth * 2
					const maxY = minY + worldHalfHeight * 2

					this.grid.add(entityId, minX, minY, maxX, maxY)
				}
			} else if (circleColliders) {
				// --- This chunk contains Circle Colliders ---
				for (let i = 0; i < chunk.size; i++) {
					const entityId = entities[i]
					const x = positions.x[i]
					const y = positions.y[i]
					const radius = circleColliders.radius[i]
					this.grid.add(entityId, x - radius, y - radius, x + radius, y + radius)
				}
			} else if (boxColliders) {
				// --- This chunk contains Box Colliders (AABBs) ---
				for (let i = 0; i < chunk.size; i++) {
					const entityId = entities[i]
					const x = positions.x[i]
					const y = positions.y[i]
					const width = boxColliders.width[i]
					const height = boxColliders.height[i]
					const minX = x - width / 2
					const minY = y - height / 2
					const maxX = minX + width
					const maxY = minY + height
					this.grid.add(entityId, minX, minY, maxX, maxY)
				}
			}
		}
	}

	destroy() {
		// This system doesn't own the grid buffers, so there's nothing to clean up here.
	}
}
