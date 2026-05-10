const { engine } = await import(`@client/Engine.js`)
const { ecs, physicsManager } = engine.getManagers()
const { SpatialHashGrid } = await import(`@core/DataStructures/SpatialHashGrid.js`)
const { PhysicsLayers } = await import(`@managers/PhysicsManager/PhysicsManager.js`)

const {
	position,
	rotation,
	circleCollider,
	boxCollider,
	orientedBoxCollider,
	collisionLayer,
	damageCollisionBuffer,
	aabb,
	lifecycleState,
} = ecs.getComponentIDs()

const { SpatialHashingSystem } = ecs.getSystemIDs()

const LIFECYCLE = ecs.getConstantsForProperty(lifecycleState, 'state')

/**
 * Performs collision detection for all collidable entities.
 * This system uses the SpatialHashGrid for broad-phase culling and then performs
 * narrow-phase checks on potential pairs. Collision results are written to each
 * entity's `CollisionBuffer` component for other systems to react to.
 */
export class CollisionDetectionSystem {
	static dependencies = {
		// This is a hard dependency: the grid MUST be populated before this system runs.
		runsAfter: [SpatialHashingSystem],
		update: {
			reads: [position, rotation, circleCollider, boxCollider, orientedBoxCollider, collisionLayer, aabb],
			writes: [damageCollisionBuffer],
		},
	}

	init() {
		const gridSABs = physicsManager.getSpatialHashGridSABs()
		this.grid = new SpatialHashGrid(gridSABs)

		// Get the global collision matrix.
		const collisionMatrixSAB = physicsManager.getCollisionMatrixSAB()
		this.collisionMatrix = new Uint32Array(collisionMatrixSAB)

		// Query for all entities that can receive damage events. Used for clearing buffers.
		this.damageableQuery = this.getQuery({
			with: [damageCollisionBuffer, lifecycleState],

		})

		// Query for "aggressors" - entities that initiate collision checks (player, projectiles).
		// This is the key optimization: we iterate over the small set of aggressors, not the large set of all enemies.
		this.aggressorQuery = this.getQuery({
			with: [position, collisionLayer, aabb, lifecycleState],
			any: [circleCollider, boxCollider, orientedBoxCollider], // Must have a shape

		})

		// Cache component type IDs for fast access.
		this.positionId = position
		this.rotationId = rotation
		this.circleColliderId = circleCollider
		this.boxColliderId = boxCollider
		this.orientedBoxColliderId = orientedBoxCollider
		this.collisionLayerId = collisionLayer
		this.damageCollisionBufferId = damageCollisionBuffer // This is the only buffer we write to now
		this.aabbId = aabb

		this.isActiveMaskId = this.getMaskId('isActive')
		this.scratchBuffer = this.createScratchBuffer()

		const MAX_QUERY_RESULTS = 1024 // A reasonable default, can be tuned.
		// Reusable objects to reduce garbage collection pressure in the update loop.
		this.spatialQueryResult = {
			count: 0,
			capacity: MAX_QUERY_RESULTS,
			entityIds: new BigUint64Array(MAX_QUERY_RESULTS),
			chunkIds: new Uint16Array(MAX_QUERY_RESULTS),
			entityIndices: new Uint16Array(MAX_QUERY_RESULTS),
		}

		// --- New reusable buffers for SAT calculations ---
		const MAX_CORNERS = 4
		const MAX_AXES = 4

		// Buffers for corner coordinates of two shapes
		this.cornersA_X = new Float32Array(MAX_CORNERS)
		this.cornersA_Y = new Float32Array(MAX_CORNERS)
		this.cornersB_X = new Float32Array(MAX_CORNERS)
		this.cornersB_Y = new Float32Array(MAX_CORNERS)

		// Buffers for separating axes
		this.axes_X = new Float32Array(MAX_AXES)
		this.axes_Y = new Float32Array(MAX_AXES)

		// Buffers for projection results [min, max]
		this.projectionA = new Float32Array(2)
		this.projectionB = new Float32Array(2)

		// A set to track which chunks have had their collision buffers modified this frame.
		// This is used for broad-phase dirty marking for reactive systems.
		this.modifiedChunks = new Set()
	}

	update({ currentTick }) {
		this.modifiedChunks.clear()

		// --- Pass 1: Clear Buffers ---
		// Reset the collision count for all entities from the previous frame.
		const damageableChunkIds = this.damageableQuery.getChunks()
		for (const chunkId of damageableChunkIds) {
			const damageBuffers = this.getComponentData(chunkId, this.damageCollisionBufferId)
			if (damageBuffers) {
				const activeCount = this.getIndicesFromMask(this.isActiveMaskId, chunkId, this.scratchBuffer)

				for (let i = 0; i < activeCount; i++) {
					const indexInChunk = this.scratchBuffer[i]
					damageBuffers.count[indexInChunk] = 0
				}
			}
		}
		this.currentTick = currentTick

		// --- Pass 2: Detect and Record Collisions ---
		// This is the aggressor-driven loop. We only iterate over players and projectiles.
		const aggressorChunkIds = this.aggressorQuery.getChunks()
		for (const chunkIdA of aggressorChunkIds) {
			const aabbsA = this.getComponentData(chunkIdA, this.aabbId)
			const layersA = this.getComponentData(chunkIdA, this.collisionLayerId)
			const entitiesA = this.getEntities(chunkIdA)
			const activeCountA = this.getIndicesFromMask(this.isActiveMaskId, chunkIdA, this.scratchBuffer)

			for (let i = 0; i < activeCountA; i++) {
				const indexA = this.scratchBuffer[i]
				// If this entity is an enemy, skip it. Enemies don't initiate checks in this model.
				const groupA = layersA.group[indexA]
				if (groupA === PhysicsLayers.ENEMY) {
					continue
				}

				const entityAId = entitiesA[indexA]
				// Broad-phase: Get potential colliders from the grid.
				// The queryBox method now resets the count internally.
				this.grid.queryBox(aabbsA.minX[indexA], aabbsA.minY[indexA], aabbsA.maxX[indexA], aabbsA.maxY[indexA], this.spatialQueryResult)


				// Narrow-phase: Check each potential pair.
				for (let j = 0; j < this.spatialQueryResult.count; j++) {
					const chunkIdB = this.spatialQueryResult.chunkIds[j]
					const entityBId = this.spatialQueryResult.entityIds[j]

					// Self-collision check. The upper-triangle check is no longer needed
					// because our outer loop is only aggressors.
					if (entityAId === entityBId) {
						continue
					}

					// The grid can contain entities that don't have a collision buffer.
					// We must check that the neighbor has at least one buffer before trying to process it.
					// This check is crucial because the spatial hash grid is populated with all collidables,
					// but our primary query is only for entities that can receive events.
					if (!this.getComponentData(chunkIdB, this.damageCollisionBufferId)) {
						continue
					}

					const layersB = this.getComponentData(chunkIdB, this.collisionLayerId)
					const indexBInChunk = this.spatialQueryResult.entityIndices[j]

					// Layer mask check: see if the entities' layers allow them to interact.
					const groupB = layersB.group[indexBInChunk]

					// Look up the masks from the global collision matrix.
					const canACollideB = (this.collisionMatrix[groupA] & groupB) !== 0
					const canBCollideA = (this.collisionMatrix[groupB] & groupA) !== 0

					if (canACollideB && canBCollideA) {
						this._checkAndRecordCollision(chunkIdA, indexA, chunkIdB, indexBInChunk, entityAId, entityBId)
					}
				}
			}
		}

		// --- Pass 3: Broad-Phase Dirty Marking ---
		// Mark all chunks that had collisions written to them as dirty for reactive systems.
		for (const chunkId of this.modifiedChunks) {
			this.markComponentDirty(chunkId, this.damageCollisionBufferId, currentTick)
		}
	}

	/**
	 * Performs the narrow-phase collision check between two entities and records the result.
	 * This is the new data-oriented heart of the collision system. It works directly on
	 * chunk data, avoiding all intermediate object allocations for the common path.
	 * @param {number} chunkIdA
	 * @param {number} indexA
	 * @param {number} chunkIdB
	 * @param {number} indexB
	 * @private
	 */
	_checkAndRecordCollision(chunkIdA, indexA, chunkIdB, indexB, entityAId, entityBId) {
		// --- Gather all necessary component data without creating objects ---
		const posA = this.getComponentData(chunkIdA, this.positionId)
		const posB = this.getComponentData(chunkIdB, this.positionId)

		const circleA = this.getComponentData(chunkIdA, this.circleColliderId)
		const circleB = this.getComponentData(chunkIdB, this.circleColliderId)
		const boxA = this.getComponentData(chunkIdA, this.boxColliderId)
		const boxB = this.getComponentData(chunkIdB, this.boxColliderId)
		const aabbA = this.getComponentData(chunkIdA, this.aabbId)
		const aabbB = this.getComponentData(chunkIdB, this.aabbId)
		const obbA = this.getComponentData(chunkIdA, this.orientedBoxColliderId)
		const obbB = this.getComponentData(chunkIdB, this.orientedBoxColliderId)

		// This is the data-oriented narrow-phase. We add optimized checks for common pairs.
		// The order of checks matters; we start with the most common pairs.

		// Case 1: Circle vs Circle
		if (circleA && circleB) {
			const dx = posA.x[indexA] - posB.x[indexB]
			const dy = posA.y[indexA] - posB.y[indexB]
			const distSq = dx * dx + dy * dy

			const radiusA = circleA.radius[indexA]
			const radiusB = circleB.radius[indexB]
			const radiiSum = radiusA + radiusB

			if (distSq <= radiiSum * radiiSum) {
				// Collision detected! Record it for both entities.
				this._addCollision(chunkIdA, indexA, entityBId)
				this._addCollision(chunkIdB, indexB, entityAId)
			}
			return // Handled
		}
		// Case 2: Box vs Box (AABB vs AABB)
		else if (boxA && boxB) {
			// The AABBs are pre-calculated by SpatialHashingSystem.
			if (
				aabbA.minX[indexA] < aabbB.maxX[indexB] &&
				aabbA.maxX[indexA] > aabbB.minX[indexB] &&
				aabbA.minY[indexA] < aabbB.maxY[indexB] &&
				aabbA.maxY[indexA] > aabbB.minY[indexB]
			) {
				this._addCollision(chunkIdA, indexA, entityBId)
				this._addCollision(chunkIdB, indexB, entityAId)
			}
			return // Handled
		}
		// Case 3: Circle vs Box
		else if (circleA && boxB) {
			const circleX = posA.x[indexA]
			const circleY = posA.y[indexA]
			const circleRadius = circleA.radius[indexA]

			const boxMinX = aabbB.minX[indexB]
			const boxMinY = aabbB.minY[indexB]
			const boxMaxX = aabbB.maxX[indexB]
			const boxMaxY = aabbB.maxY[indexB]

			const closestX = Math.max(boxMinX, Math.min(circleX, boxMaxX))
			const closestY = Math.max(boxMinY, Math.min(circleY, boxMaxY))

			const dx = circleX - closestX
			const dy = circleY - closestY
			const distanceSq = dx * dx + dy * dy

			if (distanceSq < circleRadius * circleRadius) {
				this._addCollision(chunkIdA, indexA, entityBId)
				this._addCollision(chunkIdB, indexB, entityAId)
			}
			return // Handled
		}
		// Case 4: Box vs Circle
		else if (boxA && circleB) {
			const circleX = posB.x[indexB]
			const circleY = posB.y[indexB]
			const circleRadius = circleB.radius[indexB]

			const boxMinX = aabbA.minX[indexA]
			const boxMinY = aabbA.minY[indexA]
			const boxMaxX = aabbA.maxX[indexA]
			const boxMaxY = aabbA.maxY[indexA]

			const closestX = Math.max(boxMinX, Math.min(circleX, boxMaxX))
			const closestY = Math.max(boxMinY, Math.min(circleY, boxMaxY))

			const dx = circleX - closestX
			const dy = circleY - closestY
			const distanceSq = dx * dx + dy * dy

			if (distanceSq < circleRadius * circleRadius) {
				this._addCollision(chunkIdA, indexA, entityBId)
				this._addCollision(chunkIdB, indexB, entityAId)
			}
			return // Handled
		}
		// Case 5: OBB vs OBB
		else if (obbA && obbB) {
			if (this._checkOBBvsOBB(chunkIdA, indexA, chunkIdB, indexB)) {
				this._addCollision(chunkIdA, indexA, entityBId)
				this._addCollision(chunkIdB, indexB, entityAId)
			}
			return // Handled
		}
		// Case 6: OBB vs Circle
		else if (obbA && circleB) {
			if (this._checkOBBvsCircle(chunkIdA, indexA, chunkIdB, indexB)) {
				this._addCollision(chunkIdA, indexA, entityBId)
				this._addCollision(chunkIdB, indexB, entityAId)
			}
			return // Handled
		}
		// Case 7: Circle vs OBB
		else if (circleA && obbB) {
			// Just swap the arguments for the check
			if (this._checkOBBvsCircle(chunkIdB, indexB, chunkIdA, indexA)) {
				this._addCollision(chunkIdA, indexA, entityBId)
				this._addCollision(chunkIdB, indexB, entityAId)
			}
			return // Handled
		}
		// Case 8: OBB vs Box (AABB) - Note: fixed from boxA to boxB
		else if (obbA && boxB) {
			if (this._checkOBBvsAABB(chunkIdA, indexA, chunkIdB, indexB)) {
				this._addCollision(chunkIdA, indexA, entityBId)
				this._addCollision(chunkIdB, indexB, entityAId)
			}
			return // Handled
		}
		// Case 9: Box (AABB) vs OBB
		else if (boxA && obbB) {
			// Just swap the arguments for the check
			if (this._checkOBBvsAABB(chunkIdB, indexB, chunkIdA, indexA)) {
				this._addCollision(chunkIdA, indexA, entityBId)
				this._addCollision(chunkIdB, indexB, entityAId)
			}
			return // Handled
		}
	}

	// --- SAT (Separating Axis Theorem) Helper Methods (Allocation-Free) ---

	/**
	 * Calculates the world-space corners of an OBB and writes them to output buffers.
	 * @param {Float32Array} out_cornersX - Output buffer for X coordinates.
	 * @param {Float32Array} out_cornersY - Output buffer for Y coordinates.
	 */
	_getOBBCorners(out_cornersX, out_cornersY, posX, posY, width, height, angle) {
		const halfW = width / 2
		const halfH = height / 2
		const cos = Math.cos(angle)
		const sin = Math.sin(angle)

		// Local corner vectors (unrolled for performance)
		const localX = [-halfW, halfW, halfW, -halfW]
		const localY = [-halfH, -halfH, halfH, halfH]

		// Rotate and translate to world coordinates, writing directly to output buffers
		for (let i = 0; i < 4; i++) {
			const lx = localX[i]
			const ly = localY[i]
			out_cornersX[i] = posX + lx * cos - ly * sin
			out_cornersY[i] = posY + lx * sin + ly * cos
		}
	}

	/**
	 * Projects polygon corners onto an axis and writes the min/max to an output buffer.
	 * @param {Float32Array} out_projection - Output buffer for [min, max].
	 * @param {Float32Array} cornersX - Input buffer of corner X coordinates.
	 * @param {Float32Array} cornersY - Input buffer of corner Y coordinates.
	 */
	_projectCornersOntoAxis(out_projection, cornersX, cornersY, axisX, axisY) {
		let min = Infinity
		let max = -Infinity
		for (let i = 0; i < 4; i++) {
			const projection = cornersX[i] * axisX + cornersY[i] * axisY
			if (projection < min) min = projection
			if (projection > max) max = projection
		}
		out_projection[0] = min
		out_projection[1] = max
	}

	/**
	 * Projects a circle onto an axis and writes the min/max to an output buffer.
	 * @param {Float32Array} out_projection - Output buffer for [min, max].
	 */
	_projectCircleOntoAxis(out_projection, circleX, circleY, radius, axisX, axisY) {
		const centerProjection = circleX * axisX + circleY * axisY
		out_projection[0] = centerProjection - radius
		out_projection[1] = centerProjection + radius
	}

	_checkOBBvsOBB(chunkIdA, indexA, chunkIdB, indexB) {
		const posA = this.getComponentData(chunkIdA, this.positionId)
		const obbA = this.getComponentData(chunkIdA, this.orientedBoxColliderId)
		const rotA = this.getComponentData(chunkIdA, this.rotationId)
		const posB = this.getComponentData(chunkIdB, this.positionId)
		const obbB = this.getComponentData(chunkIdB, this.orientedBoxColliderId)
		const rotB = this.getComponentData(chunkIdB, this.rotationId)

		// Get corners for both OBBs into reusable buffers
		this._getOBBCorners(
			this.cornersA_X,
			this.cornersA_Y,
			posA.x[indexA],
			posA.y[indexA],
			obbA.width[indexA],
			obbA.height[indexA],
			rotA.angle[indexA],
		)
		this._getOBBCorners(
			this.cornersB_X,
			this.cornersB_Y,
			posB.x[indexB],
			posB.y[indexB],
			obbB.width[indexB],
			obbB.height[indexB],
			rotB.angle[indexB],
		)

		// Get axes for both OBBs into reusable buffers
		const angleA = rotA.angle[indexA]
		this.axes_X[0] = Math.cos(angleA)
		this.axes_Y[0] = Math.sin(angleA)
		this.axes_X[1] = -this.axes_Y[0] // -sin(angleA)
		this.axes_Y[1] = this.axes_X[0] // cos(angleA)

		const angleB = rotB.angle[indexB]
		this.axes_X[2] = Math.cos(angleB)
		this.axes_Y[2] = Math.sin(angleB)
		this.axes_X[3] = -this.axes_Y[2] // -sin(angleB)
		this.axes_Y[3] = this.axes_X[2] // cos(angleB)

		// Check all 4 axes
		for (let i = 0; i < 4; i++) {
			const axisX = this.axes_X[i]
			const axisY = this.axes_Y[i]

			this._projectCornersOntoAxis(this.projectionA, this.cornersA_X, this.cornersA_Y, axisX, axisY)
			this._projectCornersOntoAxis(this.projectionB, this.cornersB_X, this.cornersB_Y, axisX, axisY)

			const minA = this.projectionA[0],
				maxA = this.projectionA[1]
			const minB = this.projectionB[0],
				maxB = this.projectionB[1]

			if (maxA < minB || maxB < minA) {
				return false // Found a separating axis
			}
		}

		return true // No separating axis found
	}

	_checkOBBvsCircle(obbChunkId, obbIndex, circleChunkId, circleIndex) {
		const posO = this.getComponentData(obbChunkId, this.positionId)
		const obb = this.getComponentData(obbChunkId, this.orientedBoxColliderId)
		const rotO = this.getComponentData(obbChunkId, this.rotationId)
		const posC = this.getComponentData(circleChunkId, this.positionId)
		const circle = this.getComponentData(circleChunkId, this.circleColliderId)

		const obbAngle = rotO.angle[obbIndex]
		const circleX = posC.x[circleIndex]
		const circleY = posC.y[circleIndex]
		const circleRadius = circle.radius[circleIndex]

		// Get OBB corners
		this._getOBBCorners(
			this.cornersA_X,
			this.cornersA_Y,
			posO.x[obbIndex],
			posO.y[obbIndex],
			obb.width[obbIndex],
			obb.height[obbIndex],
			obbAngle,
		)

		// 1. Check OBB's axes
		this.axes_X[0] = Math.cos(obbAngle)
		this.axes_Y[0] = Math.sin(obbAngle)
		this.axes_X[1] = -this.axes_Y[0]
		this.axes_Y[1] = this.axes_X[0]

		for (let i = 0; i < 2; i++) {
			const axisX = this.axes_X[i]
			const axisY = this.axes_Y[i]
			this._projectCornersOntoAxis(this.projectionA, this.cornersA_X, this.cornersA_Y, axisX, axisY)
			this._projectCircleOntoAxis(this.projectionB, circleX, circleY, circleRadius, axisX, axisY)

			const minA = this.projectionA[0],
				maxA = this.projectionA[1]
			const minB = this.projectionB[0],
				maxB = this.projectionB[1]

			if (maxA < minB || maxB < minA) {
				return false
			}
		}

		// 2. Check axis from circle center to closest OBB corner
		let closestCornerDistSq = Infinity
		let closestCornerX = 0,
			closestCornerY = 0

		for (let i = 0; i < 4; i++) {
			const cornerX = this.cornersA_X[i]
			const cornerY = this.cornersA_Y[i]
			const distSq = (circleX - cornerX) ** 2 + (circleY - cornerY) ** 2
			if (distSq < closestCornerDistSq) {
				closestCornerDistSq = distSq
				closestCornerX = cornerX
				closestCornerY = cornerY
			}
		}

		const axisToCornerX = closestCornerX - circleX
		const axisToCornerY = closestCornerY - circleY
		const len = Math.sqrt(axisToCornerX ** 2 + axisToCornerY ** 2)

		if (len > 0) {
			const invLen = 1 / len
			const axisX = axisToCornerX * invLen
			const axisY = axisToCornerY * invLen

			this._projectCornersOntoAxis(this.projectionA, this.cornersA_X, this.cornersA_Y, axisX, axisY)
			this._projectCircleOntoAxis(this.projectionB, circleX, circleY, circleRadius, axisX, axisY)

			const minA = this.projectionA[0],
				maxA = this.projectionA[1]
			const minB = this.projectionB[0],
				maxB = this.projectionB[1]

			if (maxA < minB || maxB < minA) {
				return false
			}
		}

		return true
	}

	_checkOBBvsAABB(obbChunkId, obbIndex, aabbChunkId, aabbIndex) {
		// This is a simplified OBB vs OBB check where the second OBB has an angle of 0.
		const posO = this.getComponentData(obbChunkId, this.positionId)
		const obb = this.getComponentData(obbChunkId, this.orientedBoxColliderId)
		const rotO = this.getComponentData(obbChunkId, this.rotationId)
		const posA = this.getComponentData(aabbChunkId, this.positionId)
		const box = this.getComponentData(aabbChunkId, this.boxColliderId) // Note: using boxCollider for AABB

		// Get corners for OBB
		this._getOBBCorners(
			this.cornersA_X,
			this.cornersA_Y,
			posO.x[obbIndex],
			posO.y[obbIndex],
			obb.width[obbIndex],
			obb.height[obbIndex],
			rotO.angle[obbIndex],
		)

		// Get axes for OBB
		const obbAngle = rotO.angle[obbIndex]
		this.axes_X[0] = Math.cos(obbAngle)
		this.axes_Y[0] = Math.sin(obbAngle)
		this.axes_X[1] = -this.axes_Y[0]
		this.axes_Y[1] = this.axes_X[0]

		// Get axes for AABB (world axes)
		this.axes_X[2] = 1
		this.axes_Y[2] = 0
		this.axes_X[3] = 0
		this.axes_Y[3] = 1

		// AABB corners can be calculated more simply
		const halfW = box.width[aabbIndex] / 2
		const halfH = box.height[aabbIndex] / 2
		const aabbX = posA.x[aabbIndex]
		const aabbY = posA.y[aabbIndex]
		this.cornersB_X[0] = aabbX - halfW
		this.cornersB_Y[0] = aabbY - halfH
		this.cornersB_X[1] = aabbX + halfW
		this.cornersB_Y[1] = aabbY - halfH
		this.cornersB_X[2] = aabbX + halfW
		this.cornersB_Y[2] = aabbY + halfH
		this.cornersB_X[3] = aabbX - halfW
		this.cornersB_Y[3] = aabbY + halfH

		// Check all 4 axes
		for (let i = 0; i < 4; i++) {
			const axisX = this.axes_X[i]
			const axisY = this.axes_Y[i]

			this._projectCornersOntoAxis(this.projectionA, this.cornersA_X, this.cornersA_Y, axisX, axisY)
			this._projectCornersOntoAxis(this.projectionB, this.cornersB_X, this.cornersB_Y, axisX, axisY)

			const minA = this.projectionA[0],
				maxA = this.projectionA[1]
			const minB = this.projectionB[0],
				maxB = this.projectionB[1]

			if (maxA < minB || maxB < minA) {
				return false
			}
		}

		return true
	}

	/** Adds a collision event to an entity's buffer. */
	_addCollision(chunkId, indexInChunk, otherEntityId) {
		const buffer = this.getComponentData(chunkId, this.damageCollisionBufferId)
		// If the entity doesn't have the required buffer type, do nothing.
		if (!buffer) return

		const count = buffer.count[indexInChunk]
		const capacity = buffer.capacity[indexInChunk]

		if (count < capacity) {
			switch (count) {
				case 0:
					buffer.event0[indexInChunk] = otherEntityId
					break
				case 1:
					buffer.event1[indexInChunk] = otherEntityId
					break
				case 2:
					buffer.event2[indexInChunk] = otherEntityId
					break
				case 3:
					buffer.event3[indexInChunk] = otherEntityId
					break
				case 4:
					buffer.event4[indexInChunk] = otherEntityId
					break
				case 5:
					buffer.event5[indexInChunk] = otherEntityId
					break
				case 6:
					buffer.event6[indexInChunk] = otherEntityId
					break
				case 7:
					buffer.event7[indexInChunk] = otherEntityId
					break
			}
			buffer.count[indexInChunk]++

			this.modifiedChunks.add(chunkId)


			
			this.markEntityDirty(chunkId, indexInChunk, this.damageCollisionBufferId, this.currentTick)
		}
	}
}
