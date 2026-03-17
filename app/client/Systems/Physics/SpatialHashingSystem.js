const { engine } = await import(`@client/Engine.js`)

const { ecs, physicsManager, queryManager } = engine.getManagers()

const { SpatialHashGrid, SPATIAL_GRID_CONFIG } = await import(`@core/DataStructures/SpatialHashGrid.js`)
const { aabb, isPooled } = ecs.getTypeIDs()

/**
 * Manages the spatial hash grid on the main thread.
 * This system is responsible for clearing, repositioning (based on player position),
 * and populating the grid with all relevant entities each frame. It also calculates
 * and caches each entity's AABB into the `AABB` component for other systems to use.
 * This prepares the grid for safe, parallel read-only queries by worker threads.
 */
export class SpatialHashingSystem {
	static dependencies = {
		update: {
			// This system now writes the calculated AABB for other systems to use.
			writes: [aabb],
		},
	}

	init() {
		// Get the main-thread instance of the spatial hash grid API.
		// The SABs are owned by the PhysicsManager.
		const gridSABs = physicsManager.getSpatialHashGridSABs()
		this.grid = new SpatialHashGrid(gridSABs)

		// Query for the player entity to track its position for grid repositioning.
		const { playerTag, position, rotation, circleCollider, boxCollider, orientedBoxCollider, collisionLayer, aabb, isPooled } =
			ecs.getTypeIDs()

		this.playerQuery = queryManager.getQuery({
			with: [playerTag, position],
		})

		// A single, unified query for all collidable entity types.
		// We also require the new `collisionLayer` component to ensure everything in the grid is categorized.
		// This is more efficient than multiple queries as it reduces loop overhead.
		this.collidablesQuery = queryManager.getQuery({
			with: [position, collisionLayer, aabb],
			any: [circleCollider, boxCollider, orientedBoxCollider],
			without: [isPooled],
		})

		// Cache component type IDs for faster access in the update loop.
		this.positionId = position
		this.rotationId = rotation
		this.circleColliderId = circleCollider
		this.boxColliderId = boxCollider
		this.orientedBoxColliderId = orientedBoxCollider
		this.collisionLayerId = collisionLayer
		this.aabbId = aabb

		// Cache the last known player position.
		this.lastPlayerX = 0
		this.lastPlayerY = 0
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
			const aabbs = chunk.componentData[this.aabbId]

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

					// Write the calculated AABB to the component for other systems to use.
					aabbs.minX[i] = minX
					aabbs.minY[i] = minY
					aabbs.maxX[i] = maxX
					aabbs.maxY[i] = maxY

					this.grid.add(entityId, chunk.chunkId, i, minX, minY, maxX, maxY)
				}
			} else if (circleColliders) {
				// --- This chunk contains Circle Colliders ---
				for (let i = 0; i < chunk.size; i++) {
					const entityId = entities[i]
					const x = positions.x[i]
					const y = positions.y[i]
					const radius = circleColliders.radius[i]
					const minX = x - radius
					const minY = y - radius
					const maxX = x + radius
					const maxY = y + radius

					aabbs.minX[i] = minX
					aabbs.minY[i] = minY
					aabbs.maxX[i] = maxX
					aabbs.maxY[i] = maxY

					this.grid.add(entityId, chunk.chunkId, i, minX, minY, maxX, maxY)
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

					aabbs.minX[i] = minX
					aabbs.minY[i] = minY
					aabbs.maxX[i] = maxX
					aabbs.maxY[i] = maxY

					this.grid.add(entityId, chunk.chunkId, i, minX, minY, maxX, maxY)
				}
			}
		}
	}

	destroy() {
		// This system doesn't own the grid buffers, so there's nothing to clean up here.
	}
}
