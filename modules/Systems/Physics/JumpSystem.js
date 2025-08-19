const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()

const { Position, Velocity, PlayerTag, Jump, PhysicsState } = componentManager.getComponents()

export class JumpSystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [PlayerTag, Position, Velocity, Jump, PhysicsState],
		})
		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.jumpTypeID = componentManager.getComponentTypeID(Jump)
		this.physicsStateTypeID = componentManager.getComponentTypeID(PhysicsState)
	}

	init() {}

	update(deltaTime, currentTick, lastTick) {
		// This system now only handles jump *initiation*.
		// Landing and state reset will be handled by a dedicated collision/grounding system.
		for (const chunk of this.query.iter()) {
			const archetypeData = chunk.archetype

			// Get pre-initialized, cached dirty markers for this archetype.
			const physicsStateMarker = archetypeManager.getDirtyMarker(archetypeData.id, this.physicsStateTypeID, currentTick)
			const jumpMarker = archetypeManager.getDirtyMarker(archetypeData.id, this.jumpTypeID, currentTick)
			const velocityMarker = archetypeManager.getDirtyMarker(archetypeData.id, this.velocityTypeID, currentTick)

			// --- Direct Data Access: Get raw TypedArrays once per chunk ---
			const velocityArrays = archetypeData.componentArrays[this.velocityTypeID]
			const jumpArrays = archetypeData.componentArrays[this.jumpTypeID]
			const physicsStateArrays = archetypeData.componentArrays[this.physicsStateTypeID]

			// Hoist property access out of the loop for JIT optimization.
			const velY = velocityArrays.y
			const wantsToJumpArr = jumpArrays.wantsToJump
			const jumpForceArr = jumpArrays.jumpForce
			const stateFlags = physicsStateArrays.stateFlags

			for (const entityIndex of chunk) {
				const wantsToJump = wantsToJumpArr[entityIndex]
				const currentStateFlags = stateFlags[entityIndex]

				// Check if the entity wants to jump and is currently grounded.
				if (wantsToJump && (currentStateFlags & PhysicsState.STATEFLAGS.GROUNDED) !== 0) {
					velY[entityIndex] = jumpForceArr[entityIndex]

					// Update state: clear GROUNDED, set AIRBORNE.
					stateFlags[entityIndex] =
						(currentStateFlags & ~PhysicsState.STATEFLAGS.GROUNDED) | PhysicsState.STATEFLAGS.AIRBORNE

					// Consume the 'wantsToJump' intent as it's a one-shot signal from input.
					wantsToJumpArr[entityIndex] = 0
					physicsStateMarker.mark(entityIndex)
					jumpMarker.mark(entityIndex)
					velocityMarker.mark(entityIndex)
				}
			}
		}
	}
}
