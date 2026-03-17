const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { playerProjectile, collisionBuffer, lifecycleState } = ecs.getTypeIDs()

const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')
const {collisionDetectionSystem} = ecs.getSystemIDs()
/**
 * Handles the immediate effects of a projectile collision, such as its own destruction.
 * It reads the collision buffer of projectiles and marks them as 'DYING' upon any collision.
 * The actual damage dealing is handled by the DamageSystem. This keeps responsibilities separate.
 */
export class ProjectileResolutionSystem {
	static dependencies = {
		// Must run after CollisionSystem but before PoolingSystem.
		runsAfter: [collisionDetectionSystem],
		update: {
			reads: [collisionBuffer, lifecycleState],
			writes: [lifecycleState],
		},
	}

	init() {
		// Query for active projectiles that have a collision buffer.
		this.projectilesQuery = this.getQuery({
			with: [playerProjectile, collisionBuffer, lifecycleState],
			react: [collisionBuffer], // Only iterate chunks where collisions have occurred.
		})

		// Pre-compile the payload to set the DYING state.
		const { payload } = this.compile(lifecycleState, { flags: LIFECYCLE.DYING })
		this.dyingPayload = payload
	}

	update({ currentTick, lastTick }) {
		for (const chunk of this.projectilesQuery.iter()) {
			const buffers = chunk.componentData[collisionBuffer]
			const states = chunk.componentData[lifecycleState]

			for (let i = 0; i < chunk.size; i++) {
				// Only act on active projectiles that have registered one or more collisions.
				if ((states.flags[i] & LIFECYCLE.ACTIVE) !== 0 && buffers.count[i] > 0) {
					const entityId = chunk.entities[i]
					this.setComponentData(entityId, this.dyingPayload)
				}
			}
		}
	}
}