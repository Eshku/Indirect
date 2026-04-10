const { engine } = await import(`@client/Engine.js`)

const { ecs, physicsManager, queryManager } = engine.getManagers()

const { SpatialHashGrid, SPATIAL_GRID_CONFIG } = await import(`@core/DataStructures/SpatialHashGrid.js`)

const { aabb, isPooled, position, rotation, circleCollider, boxCollider, orientedBoxCollider, collisionLayer } =
	ecs.getComponentIDs()

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
			reads: [position, rotation, circleCollider, boxCollider, orientedBoxCollider, collisionLayer],
			writes: [aabb],
		},
	}

	init() {
		const gridSABs = physicsManager.getSpatialHashGridSABs()
		this.grid = new SpatialHashGrid(gridSABs)

		// Query for the player entity to track its position for grid repositioning.
		const {
			playerTag,
			position,
			rotation,
			circleCollider,
			boxCollider,
			orientedBoxCollider,
			collisionLayer,
			aabb,
			isPooled,
		} = ecs.getComponentIDs()

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
		const playerChunkIds = this.playerQuery.getChunks()
		for (let i = 0; i < playerChunkIds.length; i++) {
			const chunkId = playerChunkIds[i]
			if (this.getChunkSize(chunkId) > 0) { // Check if chunk is not empty
				const pos = this.getComponentData(chunkId, this.positionId)
				// We found the player. Update our last known position.
				this.lastPlayerX = pos.x[0]
				this.lastPlayerY = pos.y[0]
				break // Only one player
			}
		}

		// Use the last known player position for the grid.
		// This ensures the grid logic runs even if the player stands still.
		const { lastPlayerX: playerX, lastPlayerY: playerY } = this

		// This performs the hysteresis check and resets the grid for the new frame.
		this.grid.clearAndReposition(playerX, playerY)

		// --- 2. Populate Phase ---

		// Process all collidable entities in a single, efficient loop.
		const collidableChunkIds = this.collidablesQuery.getChunks()
		for (let i = 0; i < collidableChunkIds.length; i++) {
			const chunkId = collidableChunkIds[i]
			const positions = this.getComponentData(chunkId, this.positionId)
			const entities = this.getEntities(chunkId)
			const chunkSize = this.getChunkSize(chunkId)

			// These components may or may not exist on the chunk's archetype.
			const circleColliders = this.getComponentData(chunkId, this.circleColliderId)
			const boxColliders = this.getComponentData(chunkId, this.boxColliderId)
			const orientedBoxColliders = this.getComponentData(chunkId, this.orientedBoxColliderId)
			const rotations = this.getComponentData(chunkId, this.rotationId)

			const aabbs = this.getComponentData(chunkId, this.aabbId)

			// This loop calculates a single, unified AABB for each entity,
			// correctly encompassing all of its potential collider shapes.
			for (let j = 0; j < chunkSize; j++) {
				const x = positions.x[j]
				const y = positions.y[j]

				let minX = Infinity,
					minY = Infinity,
					maxX = -Infinity,
					maxY = -Infinity
				let hasCollider = false

				// Accumulate bounds from circle collider if it exists
				if (circleColliders) {
					const radius = circleColliders.radius[j]
					minX = Math.min(minX, x - radius)
					minY = Math.min(minY, y - radius)
					maxX = Math.max(maxX, x + radius)
					maxY = Math.max(maxY, y + radius)
					hasCollider = true
				}

				// Accumulate bounds from box collider if it exists
				if (boxColliders) {
					const halfWidth = boxColliders.width[j] / 2
					const halfHeight = boxColliders.height[j] / 2
					minX = Math.min(minX, x - halfWidth)
					minY = Math.min(minY, y - halfHeight)
					maxX = Math.max(maxX, x + halfWidth)
					maxY = Math.max(maxY, y + halfHeight)
					hasCollider = true
				}

				// Accumulate bounds from oriented box collider if it exists
				if (orientedBoxColliders) {
					const angle = rotations.angle[j]
					const halfWidth = orientedBoxColliders.width[j] / 2
					const halfHeight = orientedBoxColliders.height[j] / 2

					const c = Math.abs(Math.cos(angle))
					const s = Math.abs(Math.sin(angle))
					const worldHalfWidth = halfWidth * c + halfHeight * s
					const worldHalfHeight = halfWidth * s + halfHeight * c

					minX = Math.min(minX, x - worldHalfWidth)
					minY = Math.min(minY, y - worldHalfHeight)
					maxX = Math.max(maxX, x + worldHalfWidth)
					maxY = Math.max(maxY, y + worldHalfHeight)
					hasCollider = true
				}

				// Only add to grid if a collider was found and bounds are valid.
				if (hasCollider) {
					// Write the calculated AABB to the component for other systems to use.
					aabbs.minX[j] = minX
					aabbs.minY[j] = minY
					aabbs.maxX[j] = maxX
					aabbs.maxY[j] = maxY

					this.grid.add(entities[j], chunkId, j, minX, minY, maxX, maxY)
				}
			}
		}
	}

	destroy() {
		// This system doesn't own the grid buffers, so there's nothing to clean up here.
	}
}
