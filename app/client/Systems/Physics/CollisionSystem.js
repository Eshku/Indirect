const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()

const { queryManager } = ecs
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

/**
 * A custom, AABB-based collision system that handles interactions between characters and platforms.
 */
export class CollisionSystem {
	constructor() {
		this.commands = null // Injected by SystemManager

		const { position, velocity, isGrounded, collisionFlags, collider, platformTag, landedEvent, leftSurfaceEvent } =
			ecs.getTypeIDs()
			
		Object.assign(this, {
			position,
			velocity,
			isGrounded,
			collisionFlags,
			collider,
			platformTag,
			landedEvent,
			leftSurfaceEvent,
		})

		const { payload: landedEventPayload, mutators: landedEventMutators } = payloadCompiler.compileEntity({
			landedEvent: { entityId: 0 },
		})

		const { payload: leftSurfaceEventPayload, mutators: leftSurfaceEventMutators } = payloadCompiler.compileEntity({
			leftSurfaceEvent: { entityId: 0 },
		})

		this.landedEventPayload = landedEventPayload
		this.landedEventMutators = landedEventMutators
		this.leftSurfaceEventPayload = leftSurfaceEventPayload
		this.leftSurfaceEventMutators = leftSurfaceEventMutators

		this.collisionFlagsConstants = ecs.componentManager.getConstantsForProperty(collisionFlags, 'collisionFlags')

		this.characterQuery = queryManager.getQuery({
			with: [position, velocity, isGrounded, collisionFlags, collider],
		})

		this.allPlatformsQuery = queryManager.getQuery({
			with: [position, collider, platformTag],
		})
	}

	update({deltaTime, currentTick, lastTick}) {
		for (const chunk of this.characterQuery.iter()) {
			const charPosArrays = chunk.componentData[this.position]
			const charVelArrays = chunk.componentData[this.velocity]
			const charIsGroundedArrays = chunk.componentData[this.isGrounded]
			const charCollisionFlagsArrays = chunk.componentData[this.collisionFlags]
			const charColliderArrays = chunk.componentData[this.collider]

			const charPosX = charPosArrays.x
			const charPosY = charPosArrays.y
			const charVelX = charVelArrays.x
			const charVelY = charVelArrays.y
			const charIsGrounded = charIsGroundedArrays.isGrounded
			const charCollisionFlags = charCollisionFlagsArrays.collisionFlags
			const charColliderHeight = charColliderArrays.height
			const charColliderWidth = charColliderArrays.width

			let posModified = false
			let velModified = false
			let groundedModified = false
			let flagsModified = false

			for (let charIndexInChunk = 0; charIndexInChunk < chunk.size; charIndexInChunk++) {
				const charHalfW = charColliderWidth[charIndexInChunk] / 2
				const charHalfH = charColliderHeight[charIndexInChunk] / 2
				const wasGrounded = charIsGrounded[charIndexInChunk] === 1

				const originalCharX = charPosX[charIndexInChunk]
				const originalCharY = charPosY[charIndexInChunk]
				const charCurrentVelY = charVelY[charIndexInChunk]

				let finalTargetX = originalCharX
				let finalTargetY = originalCharY
				let minHorizontalPush = Infinity
				let minVerticalPush = Infinity
				let bestHorizontalPlatform = null
				let bestVerticalPlatform = null
				let isOverlapping = false

				// --- Grounded Check Probe ---
				const groundProbeDistance = 1 // Small distance to check for ground below the character.
				let isSupportedByPlatform = false

				for (const platChunk of this.allPlatformsQuery.iter()) {
					const platformPosArrays = platChunk.componentData[this.position]
					const platformColliderArrays = platChunk.componentData[this.collider]

					const platX = platformPosArrays.x
					const platY = platformPosArrays.y
					const platW = platformColliderArrays.width
					const platH = platformColliderArrays.height

					for (let platformIndexInChunk = 0; platformIndexInChunk < platChunk.size; platformIndexInChunk++) {
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
								const currentTargetX =
									dx > 0 ? platCenterX + platHalfW + charHalfW : platCenterX - platHalfW - charHalfW
								const push = Math.abs(currentTargetX - originalCharX)
								if (push < minHorizontalPush) {
									minHorizontalPush = push
									finalTargetX = currentTargetX
									bestHorizontalPlatform = { centerX: platCenterX }
								}
							} else {
								// Vertical collision is dominant
								const currentTargetY =
									dy > 0 ? platCenterY + platHalfH + charHalfH : platCenterY - platHalfH - charHalfH
								const push = Math.abs(currentTargetY - originalCharY)
								if (push < minVerticalPush) {
									minVerticalPush = push
									finalTargetY = currentTargetY
									bestVerticalPlatform = { centerY: platCenterY }
								}
							}
						}

						// Perform the ground probe check regardless of overlap
						const probeTop = originalCharY - charHalfH
						const probeBottom = probeTop - groundProbeDistance
						const platformTop = platCenterY + platHalfH
						const platformBottom = platCenterY - platHalfH

						if (probeBottom <= platformTop && probeTop >= platformBottom && Math.abs(dx) < combinedHalfWidths) {
							// The character's feet are within a small distance of a platform surface.
							isSupportedByPlatform = true
						}
					}
				}

				charPosX[charIndexInChunk] = finalTargetX
				charPosY[charIndexInChunk] = finalTargetY

				let collisionDirectionFlagsThisFrame = this.collisionFlagsConstants.NONE
				let isGroundedThisFrame = false

				if (charPosX[charIndexInChunk] !== originalCharX || charPosY[charIndexInChunk] !== originalCharY) {
					chunk.dirtyTicks[this.position][charIndexInChunk] = currentTick
					posModified = true
				}

				if (bestHorizontalPlatform) {
					charVelX[charIndexInChunk] = 0
					const dx = originalCharX - bestHorizontalPlatform.centerX
					collisionDirectionFlagsThisFrame |= dx > 0 ? this.collisionFlagsConstants.RIGHT : this.collisionFlagsConstants.LEFT
				}
				if (bestVerticalPlatform) {
					charVelY[charIndexInChunk] = 0
					const dy = originalCharY - bestVerticalPlatform.centerY

					// If dy > 0, character is above the platform, so collision is on the character's bottom.
					// This is also our condition for being "grounded".
					if (dy > 0) {
						isGroundedThisFrame = true

						collisionDirectionFlagsThisFrame |= this.collisionFlagsConstants.BOTTOM
					} else {
						collisionDirectionFlagsThisFrame |= this.collisionFlagsConstants.TOP
					}
				}

				if (bestHorizontalPlatform || bestVerticalPlatform) {
					chunk.dirtyTicks[this.velocity][charIndexInChunk] = currentTick
					velModified = true
				}

				const oldCollisionFlags = charCollisionFlags[charIndexInChunk]
				let isGroundedNow = wasGrounded

				// A jump was initiated in the same frame.
				const justJumped = wasGrounded && charCurrentVelY > 0

				if ((isGroundedThisFrame || isSupportedByPlatform) && !justJumped && charCurrentVelY <= 0) {
					// Character is on the ground and didn't just jump.
					isGroundedNow = true

					if (!wasGrounded) {
						// This is a landing event.
						// Use the mutator to set the correct entityId on the pre-compiled payload.
						this.landedEventMutators.landedEvent.entityId[0] = chunk.entities[charIndexInChunk]
						this.commands.createEntity(this.landedEventPayload)
					}
				} else {
					// Character is airborne for one of three reasons:
					// 1. They just jumped (justJumped is true).
					// 2. They were in the air and are still in the air (!wasGrounded && !isGroundedThisFrame).
					// 3. They were on the ground and now they are not (e.g., walked off a ledge).
					isGroundedNow = false
					if (wasGrounded && !justJumped) {
						// This is the "walked off a ledge" case. Use the pre-compiled payload.
						this.leftSurfaceEventMutators.leftSurfaceEvent.entityId[0] = chunk.entities[charIndexInChunk]
						this.commands.createEntity(this.leftSurfaceEventPayload)
					}
				}

				if (isGroundedNow !== wasGrounded) {
					charIsGrounded[charIndexInChunk] = isGroundedNow ? 1 : 0
					chunk.dirtyTicks[this.isGrounded][charIndexInChunk] = currentTick
					groundedModified = true
				}
				if (collisionDirectionFlagsThisFrame !== oldCollisionFlags) {
					charCollisionFlags[charIndexInChunk] = collisionDirectionFlagsThisFrame
					chunk.dirtyTicks[this.collisionFlags][charIndexInChunk] = currentTick
					flagsModified = true
				}
			}

			if (posModified) chunk.markChunkDirty(this.position, currentTick)
			if (velModified) chunk.markChunkDirty(this.velocity, currentTick)
			if (groundedModified) chunk.markChunkDirty(this.isGrounded, currentTick)
			if (flagsModified) chunk.markChunkDirty(this.collisionFlags, currentTick)
		}
	}

	destroy() {}
}
