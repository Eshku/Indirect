const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

/**
 * A custom, AABB-based collision system that handles interactions between characters and platforms.
 */
export class CollisionSystem {
	constructor() {
		this.allowInternalConflicts = true
		this.commands = null // Injected by SystemManager
		
		const {
			Position,
			Velocity,
			IsGrounded,
			CollisionFlags,
			Collider,
			PlatformTag,
			LandedEvent,
			LeftSurfaceEvent,
		} = componentManager.getTypeIDs()

		this.positionTypeID = Position
		this.velocityTypeID = Velocity
		this.isGroundedTypeID = IsGrounded
		this.collisionFlagsTypeID = CollisionFlags
		this.colliderTypeID = Collider
		this.landedEventTypeID = LandedEvent
		this.leftSurfaceEventTypeID = LeftSurfaceEvent

		// Pre-compile payloads for our event entities. This is much faster than creating
		// new objects in the update loop.
		this.landedEventPayload = payloadCompiler.compileEntity({
			LandedEvent: { entityId: 0 }, // The entityId will be mutated at runtime.
		})
		this.leftSurfaceEventPayload = payloadCompiler.compileEntity({
			LeftSurfaceEvent: { entityId: 0 },
		})
		this.COLLISION_FLAGS = componentManager.getConstantsForProperty(CollisionFlags, 'collisionFlags')

		this.characterQuery = queryManager.getQuery({
			with: [Position, Velocity, IsGrounded, CollisionFlags, Collider],
		})

		this.allPlatformsQuery = queryManager.getQuery({
			with: [Position, Collider, PlatformTag],
		})
	}

	update(deltaTime, currentTick) {
		for (const charChunk of this.characterQuery.iter()) {
			const positionMarker = charChunk.getDirtyMarker(this.positionTypeID, currentTick)
			const velocityMarker = charChunk.getDirtyMarker(this.velocityTypeID, currentTick)
			const isGroundedMarker = charChunk.getDirtyMarker(this.isGroundedTypeID, currentTick)
			const collisionFlagsMarker = charChunk.getDirtyMarker(this.collisionFlagsTypeID, currentTick)

			const charPosArrays = charChunk.componentArrays[this.positionTypeID]
			const charVelArrays = charChunk.componentArrays[this.velocityTypeID]
			const charIsGroundedArrays = charChunk.componentArrays[this.isGroundedTypeID]
			const charCollisionFlagsArrays = charChunk.componentArrays[this.collisionFlagsTypeID]
			const charColliderArrays = charChunk.componentArrays[this.colliderTypeID]

			const charPosX = charPosArrays.x
			const charPosY = charPosArrays.y
			const charVelX = charVelArrays.x
			const charVelY = charVelArrays.y
			const charIsGrounded = charIsGroundedArrays.isGrounded
			const charCollisionFlags = charCollisionFlagsArrays.collisionFlags
			const charColliderHeight = charColliderArrays.height
			const charColliderWidth = charColliderArrays.width

			for (let charIndexInChunk = 0; charIndexInChunk < charChunk.size; charIndexInChunk++) {
				const charHalfW = charColliderWidth[charIndexInChunk] / 2
				const charHalfH = charColliderHeight[charIndexInChunk] / 2
				const wasGrounded = charIsGrounded[charIndexInChunk] === 1;

				const originalCharX = charPosX[charIndexInChunk]
				const originalCharY = charPosY[charIndexInChunk]
				const charCurrentVelY = charVelY[charIndexInChunk];

				let finalTargetX = originalCharX
				let finalTargetY = originalCharY
				let minHorizontalPush = Infinity
				let minVerticalPush = Infinity
				let bestHorizontalPlatform = null
				let bestVerticalPlatform = null
				let isOverlapping = false

				// --- Grounded Check Probe ---
				const groundProbeDistance = 1; // Small distance to check for ground below the character.
				let isSupportedByPlatform = false;

				for (const platformChunk of this.allPlatformsQuery.iter()) {
					const platformPosArrays = platformChunk.componentArrays[this.positionTypeID]
					const platformColliderArrays = platformChunk.componentArrays[this.colliderTypeID]

					const platX = platformPosArrays.x
					const platY = platformPosArrays.y
					const platW = platformColliderArrays.width
					const platH = platformColliderArrays.height

					for (let platformIndexInChunk = 0; platformIndexInChunk < platformChunk.size; platformIndexInChunk++) {
						const platCenterX = platX[platformIndexInChunk]
						const platCenterY = platY[platformIndexInChunk]
						const platHalfW = platW[platformIndexInChunk] / 2
						const platHalfH = platH[platformIndexInChunk] / 2

						const dx = originalCharX - platCenterX
						const dy = originalCharY - platCenterY
						const combinedHalfWidths = charHalfW + platHalfW
						const combinedHalfHeights = charHalfH + platHalfH

						if (Math.abs(dx) < combinedHalfWidths && Math.abs(dy) < combinedHalfHeights) {
							isOverlapping = true
							const overlapX = combinedHalfWidths - Math.abs(dx)
							const overlapY = combinedHalfHeights - Math.abs(dy)

							if (overlapX < overlapY) {
								// Horizontal collision is dominant
								const currentTargetX = dx > 0 ? platCenterX + platHalfW + charHalfW : platCenterX - platHalfW - charHalfW
								const push = Math.abs(currentTargetX - originalCharX)
								if (push < minHorizontalPush) {
									minHorizontalPush = push
									finalTargetX = currentTargetX
									bestHorizontalPlatform = { centerX: platCenterX }
								}
							} else {
								// Vertical collision is dominant
								const currentTargetY = dy > 0 ? platCenterY + platHalfH + charHalfH : platCenterY - platHalfH - charHalfH
								const push = Math.abs(currentTargetY - originalCharY)
								if (push < minVerticalPush) {
									minVerticalPush = push
									finalTargetY = currentTargetY
									bestVerticalPlatform = { centerY: platCenterY }
								}
							}
						}

						// Perform the ground probe check regardless of overlap
						const probeTop = originalCharY - charHalfH;
						const probeBottom = probeTop - groundProbeDistance;
						const platformTop = platCenterY + platHalfH;
						const platformBottom = platCenterY - platHalfH;

						if (probeBottom <= platformTop && probeTop >= platformBottom && Math.abs(dx) < combinedHalfWidths) {
							// The character's feet are within a small distance of a platform surface.
							isSupportedByPlatform = true;
						}
					}
				}

				charPosX[charIndexInChunk] = finalTargetX
				charPosY[charIndexInChunk] = finalTargetY

				let collisionDirectionFlagsThisFrame = this.COLLISION_FLAGS.NONE
				let isGroundedThisFrame = false

				if (charPosX[charIndexInChunk] !== originalCharX || charPosY[charIndexInChunk] !== originalCharY) {
					positionMarker.mark(charIndexInChunk)
				}

				if (bestHorizontalPlatform) {
					charVelX[charIndexInChunk] = 0
					const dx = originalCharX - bestHorizontalPlatform.centerX
					collisionDirectionFlagsThisFrame |= dx > 0 ? this.COLLISION_FLAGS.RIGHT : this.COLLISION_FLAGS.LEFT
				}
				if (bestVerticalPlatform) {

					charVelY[charIndexInChunk] = 0
					const dy = originalCharY - bestVerticalPlatform.centerY

					// If dy > 0, character is above the platform, so collision is on the character's bottom.
					// This is also our condition for being "grounded".
					if (dy > 0) {

						isGroundedThisFrame = true

						collisionDirectionFlagsThisFrame |= this.COLLISION_FLAGS.BOTTOM
					} else {
						collisionDirectionFlagsThisFrame |= this.COLLISION_FLAGS.TOP
					}
				}

				if (bestHorizontalPlatform || bestVerticalPlatform) {

					velocityMarker.mark(charIndexInChunk)
				}

				const oldCollisionFlags = charCollisionFlags[charIndexInChunk]
				let isGroundedNow = wasGrounded

				// A jump was initiated in the same frame.
				const justJumped = wasGrounded && charCurrentVelY > 0;

				if ((isGroundedThisFrame || isSupportedByPlatform) && !justJumped && charCurrentVelY <= 0) {
					// Character is on the ground and didn't just jump.
					isGroundedNow = true

					if (!wasGrounded) {
						// This is a landing event.
						const { mutators, payload } = this.landedEventPayload
						// Use the mutator to set the correct entityId on the pre-compiled payload.
						mutators.LandedEvent.entityId[0] = charChunk.entities[charIndexInChunk]
						this.commands.createEntity(payload)
					}
				} else {
					// Character is airborne for one of three reasons:
					// 1. They just jumped (justJumped is true).
					// 2. They were in the air and are still in the air (!wasGrounded && !isGroundedThisFrame).
					// 3. They were on the ground and now they are not (e.g., walked off a ledge).
					isGroundedNow = false
					if (wasGrounded && !justJumped) {

						// This is the "walked off a ledge" case. Use the pre-compiled payload.
						const { mutators, payload } = this.leftSurfaceEventPayload
						mutators.LeftSurfaceEvent.entityId[0] = charChunk.entities[charIndexInChunk]
						this.commands.createEntity(payload)
					}
				}

				if (isGroundedNow !== wasGrounded) {
					charIsGrounded[charIndexInChunk] = isGroundedNow ? 1 : 0
					isGroundedMarker.mark(charIndexInChunk)
				}
				if (collisionDirectionFlagsThisFrame !== oldCollisionFlags) {
					charCollisionFlags[charIndexInChunk] = collisionDirectionFlagsThisFrame
					collisionFlagsMarker.mark(charIndexInChunk)
				}
			}
		}
	}
}
