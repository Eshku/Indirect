const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()
/* const { Archetype } = await import(`${PATH_MANAGERS}/ArchetypeManager/Archetype.js`) */

const { PhysicsState, Velocity } = componentManager.getComponents()

export class GravitySystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [PhysicsState, Velocity],
		})
		this.physicsStateTypeID = componentManager.getComponentTypeID(PhysicsState)
		this.velocityTypeID = componentManager.getComponentTypeID(Velocity)
		this.gravity = 800 // A constant force pulling entities down in pixels/second^2. Tune this value.
	}
	init() {}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const archetypeData = chunk.archetype

			// Get a pre-initialized, cached dirty marker for this archetype.
			const velocityMarker = archetypeManager.getDirtyMarker(archetypeData.id, this.velocityTypeID, currentTick)

			// --- Direct Data Access: Get raw TypedArrays once per chunk ---
			const physicsStateArrays = archetypeData.componentArrays[this.physicsStateTypeID]
			const velocityArrays = archetypeData.componentArrays[this.velocityTypeID]

			// Hoist property access out of the loop for JIT optimization.
			const stateFlags = physicsStateArrays.stateFlags
			const velY = velocityArrays.y

			for (const entityIndex of chunk) {
				// Apply gravity only if the entity is in the AIRBORNE state.
				if ((stateFlags[entityIndex] & PhysicsState.STATEFLAGS.AIRBORNE) !== 0) {
					velY[entityIndex] -= this.gravity * deltaTime
					velocityMarker.mark(entityIndex)
				}
			}
		}
	}
}
