const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()

const { Position, Velocity, PhysicsState, PlatformTag, Collider, LandedEvent, LeftSurfaceEvent } =
	componentManager.getComponents()

/**
 * A custom, AABB-based collision system that handles interactions between characters and platforms.
 * It is responsible for:
 * 1. Detecting when an 'airborne' character lands on a platform and changing its state to 'grounded'.
 * 2. Preventing a 'grounded' character from walking off the edges of a platform.
 * 3. Detecting when a 'grounded' character has walked off a platform and changing its state to 'airborne'.
 *
 * This system operates purely on component data (Position, Collider) and does not use a
 * generic physics engine, aligning with the game's custom character controller design.
 */
export class PlatformCollisionSystem {
	constructor() {
		/**
		 * This flag tells the SystemGraphBuilder to suppress warnings about potential
		 * read/write conflicts between queries within this system. We set this to true
		 * because we have manually ensured that the logic in `update()` is safe (e.g.,
		 * reading all platform data before modifying character data).
		 */
		this.allowInternalConflicts = true
		this.commands = null // Injected by SystemManager

		// Cache component TypeIDs for performance
		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.physicsStateTypeID = componentManager.getComponentTypeID(PhysicsState)
		this.colliderTypeID = componentManager.getComponentTypeID(Collider)
		this.landedEventTypeID = componentManager.getComponentTypeID(LandedEvent)
		this.leftSurfaceEventTypeID = componentManager.getComponentTypeID(LeftSurfaceEvent)

		// Cache archetype IDs for event creation. This is safe because archetype IDs are immortal.
		// This avoids having to look up the archetype on every event creation.
		this.landedEventArchetypeID = archetypeManager.getArchetype([this.landedEventTypeID])
		this.leftSurfaceEventArchetypeID = archetypeManager.getArchetype([this.leftSurfaceEventTypeID])

		//  Queries
		this.characterQuery = queryManager.getQuery({
			with: [Position, Velocity, PhysicsState, Collider],
		})

		this.allPlatformsQuery = queryManager.getQuery({
			with: [Position, Collider, PlatformTag],
		})
	}

	update(deltaTime, currentTick) {
		// For each character, we will perform two passes over all platforms: one to resolve
		// horizontal collisions and one for vertical. This separation is crucial for robustly
		// handling corner cases and is preserved from the original logic.

		for (const chunk of this.characterQuery.iter()) {
			const charArchetype = chunk.archetype

			const positionMarker = archetypeManager.getDirtyMarker(charArchetype.id, this.positionTypeID, currentTick)
			const velocityMarker = archetypeManager.getDirtyMarker(charArchetype.id, this.velocityTypeID, currentTick)
			const physicsStateMarker = archetypeManager.getDirtyMarker(charArchetype.id, this.physicsStateTypeID, currentTick)

			const charPosArrays = charArchetype.componentArrays[this.positionTypeID]
			const charVelArrays = charArchetype.componentArrays[this.velocityTypeID]
			const charStateArrays = charArchetype.componentArrays[this.physicsStateTypeID]
			const charColliderArrays = charArchetype.componentArrays[this.colliderTypeID]

			const charPosX = charPosArrays.x
			const charPosY = charPosArrays.y
			const charVelX = charVelArrays.x
			const charVelY = charVelArrays.y
			const charStateFlags = charStateArrays.stateFlags
			const charCollisionFlags = charStateArrays.collisionFlags
			const charColliderHeight = charColliderArrays.height
			const charColliderWidth = charColliderArrays.width

			for (const charIndex of chunk) {
				const charHalfW = charColliderWidth[charIndex] / 2
				const charHalfH = charColliderHeight[charIndex] / 2
				const wasGrounded = (charStateFlags[charIndex] & PhysicsState.STATEFLAGS.GROUNDED) !== 0

				// Axis-Separated Collision Resolution
				const originalCharX = charPosX[charIndex]
				const originalCharY = charPosY[charIndex]
				let onPlatform = false // Will be true if any overlap is detected.

				// --- Pass 1: Horizontal Collision ---
				let horizontalTarget = originalCharX
				let minHorizontalPush = Infinity
				let bestHorizontalPlatform = null

				for (const platformChunk of this.allPlatformsQuery.iter()) {
					const platformArchetype = platformChunk.archetype
					const platformPosArrays = platformArchetype.componentArrays[this.positionTypeID]
					const platformColliderArrays = platformArchetype.componentArrays[this.colliderTypeID]

					const platformPosX = platformPosArrays.x
					const platformPosY = platformPosArrays.y
					const platformWidth = platformColliderArrays.width
					const platformHeight = platformColliderArrays.height

					for (const platformIndex of platformChunk) {
						const platformCenterX = platformPosX[platformIndex]
						const platformCenterY = platformPosY[platformIndex]
						const platformHalfWidth = platformWidth[platformIndex] / 2
						const platformHalfHeight = platformHeight[platformIndex] / 2

						// AABB collision check
						const dx = originalCharX - platformCenterX
						const dy = originalCharY - platformCenterY
						const combinedHalfWidths = charHalfW + platformHalfWidth
						const combinedHalfHeights = charHalfH + platformHalfHeight

						if (Math.abs(dx) <= combinedHalfWidths && Math.abs(dy) <= combinedHalfHeights) {
							onPlatform = true
							const overlapX = combinedHalfWidths - Math.abs(dx)
							const overlapY = combinedHalfHeights - Math.abs(dy)

							if (overlapX < overlapY) {
								let currentTargetX
								if (dx > 0) {
									currentTargetX = platformCenterX + platformHalfWidth + charHalfW
								} else {
									currentTargetX = platformCenterX - platformHalfWidth - charHalfW
								}

								const push = Math.abs(currentTargetX - originalCharX)
								if (push < minHorizontalPush) {
									minHorizontalPush = push
									horizontalTarget = currentTargetX
									bestHorizontalPlatform = { centerX: platformCenterX } // Only need centerX
								}
							}
						}
					}
				}

				// --- Pass 2: Vertical Collision ---
				let verticalTarget = originalCharY
				let minVerticalPush = Infinity
				let bestVerticalPlatform = null

				for (const platformChunk of this.allPlatformsQuery.iter()) {
					const platformArchetype = platformChunk.archetype
					const platformPosArrays = platformArchetype.componentArrays[this.positionTypeID]
					const platformColliderArrays = platformArchetype.componentArrays[this.colliderTypeID]

					// Hoist platform property access
					const platformPosX = platformPosArrays.x
					const platformPosY = platformPosArrays.y
					const platformWidth = platformColliderArrays.width
					const platformHeight = platformColliderArrays.height

					for (const platformIndex of platformChunk) {
						const platformCenterX = platformPosX[platformIndex]
						const platformCenterY = platformPosY[platformIndex]
						const platformHalfWidth = platformWidth[platformIndex] / 2
						const platformHalfHeight = platformHeight[platformIndex] / 2

						// AABB check (note: uses originalCharX for axis independence)
						const dx = originalCharX - platformCenterX
						const dy = originalCharY - platformCenterY
						const combinedHalfWidths = charHalfW + platformHalfWidth
						const combinedHalfHeights = charHalfH + platformHalfHeight

						if (Math.abs(dx) <= combinedHalfWidths && Math.abs(dy) <= combinedHalfHeights) {
							onPlatform = true
							const overlapX = combinedHalfWidths - Math.abs(dx)
							const overlapY = combinedHalfHeights - Math.abs(dy)

							if (overlapY <= overlapX) {
								// Prioritize vertical resolution on ties
								let currentTargetY
								if (dy > 0) {
									// Landed on top
									currentTargetY = platformCenterY + platformHalfHeight + charHalfH
								} else {
									// Hit head on bottom
									currentTargetY = platformCenterY - platformHalfHeight - charHalfH
								}

								const push = Math.abs(currentTargetY - originalCharY)
								if (push < minVerticalPush) {
									minVerticalPush = push
									verticalTarget = currentTargetY
									bestVerticalPlatform = { centerY: platformCenterY } // Only need centerY
								}
							}
						}
					}
				}

				// --- Apply Resolutions and Update State ---
				charPosX[charIndex] = horizontalTarget
				charPosY[charIndex] = verticalTarget

				let collisionDirectionFlagsThisFrame = PhysicsState.COLLISIONFLAGS.COLLIDE_NONE
				let isGroundedThisFrame = false

				if (charPosX[charIndex] !== originalCharX || charPosY[charIndex] !== originalCharY) {
					positionMarker.mark(charIndex)
				}

				if (bestHorizontalPlatform) {
					charVelX[charIndex] = 0
					const dx = originalCharX - bestHorizontalPlatform.centerX // Use original for direction
					collisionDirectionFlagsThisFrame |=
						dx > 0 ? PhysicsState.COLLISIONFLAGS.COLLIDE_LEFT : PhysicsState.COLLISIONFLAGS.COLLIDE_RIGHT
				}
				if (bestVerticalPlatform) {
					charVelY[charIndex] = 0
					const dy = originalCharY - bestVerticalPlatform.centerY // Use original for direction
					isGroundedThisFrame = dy > 0
					collisionDirectionFlagsThisFrame |=
						dy > 0 ? PhysicsState.COLLISIONFLAGS.COLLIDE_BOTTOM : PhysicsState.COLLISIONFLAGS.COLLIDE_TOP
				}

				if (bestHorizontalPlatform || bestVerticalPlatform) {
					velocityMarker.mark(charIndex)
				}

				// --- Update PhysicsState Component ---
				const currentFlags = charStateFlags[charIndex]
				const oldCollisionFlags = charCollisionFlags[charIndex]
				let newFlags = currentFlags

				if (isGroundedThisFrame) {
					// The character landed on top of a platform.
					newFlags = (currentFlags & ~PhysicsState.STATEFLAGS.AIRBORNE) | PhysicsState.STATEFLAGS.GROUNDED
					if (!wasGrounded) {
						// Fire a 'just landed' event.
						const entityId = charArchetype.entities[charIndex]
						this.commands.createEntityInArchetypeWithComponent(this.landedEventArchetypeID, this.landedEventTypeID, {
							entityId,
						})
					}
				} else if (onPlatform) {
					// A non-grounding collision occurred (e.g., bumped a side wall).
					// If the character was already on the ground, they should remain grounded.
					// This prevents jittering at platform edges.
					if (wasGrounded) {
						newFlags = currentFlags // No state change.
					} else {
						// If they were in the air and hit a wall, they remain airborne.
						newFlags = (currentFlags & ~PhysicsState.STATEFLAGS.GROUNDED) | PhysicsState.STATEFLAGS.AIRBORNE
					}
				} else {
					// No collision with any platform this frame. The character must be airborne.
					newFlags = (currentFlags & ~PhysicsState.STATEFLAGS.GROUNDED) | PhysicsState.STATEFLAGS.AIRBORNE
					if (wasGrounded) {
						// Fire a 'just fell off' event.
						const entityId = charArchetype.entities[charIndex]
						this.commands.createEntityInArchetypeWithComponent(
							this.leftSurfaceEventArchetypeID,
							this.leftSurfaceEventTypeID,
							{ entityId }
						)
					}
				}

				// Only write to components and mark dirty if there's an actual change.
				if (newFlags !== currentFlags || collisionDirectionFlagsThisFrame !== oldCollisionFlags) {
					charStateFlags[charIndex] = newFlags
					charCollisionFlags[charIndex] = collisionDirectionFlagsThisFrame
					physicsStateMarker.mark(charIndex)
				}
			}
		}
	}
}
