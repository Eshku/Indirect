const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { collisionBuffer, damage, health, isPooled, lifecycleState } = ecs.getTypeIDs()

const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')

/**
 * Applies damage to entities based on collision events.
 * It reads the CollisionBuffer of entities that can deal damage and,
 * for each collision, reduces the health of the target entity.
 * This system iterates over entities that can *receive* damage, checks their collision
 * buffer, and accumulates damage from any colliding entities that have a `Damage` component.
 */
export class DamageSystem {
	static dependencies = {
		// Must run after CollisionSystem populates the buffers.
		runsAfter: [ecs.getSystemIDs().CollisionSystem],
		update: {
			reads: [health, collisionBuffer, lifecycleState, damage], // Reads damage from other entities
			writes: [health], // This system modifies the health of other entities.
		},
	}

	init() {
		// Query for active entities that can receive damage.
		this.receiversQuery = this.getQuery({
			with: [health, collisionBuffer, lifecycleState],
			without: [isPooled],
		})

		// Pre-compile a payload for updating health. This is more efficient
		// than creating a new object for setComponentData in the loop.
		const { payload, mutators } = this.compile(health)
		this.healthUpdatePayload = payload
		this.healthUpdateMutators = mutators
	}

	update({ currentTick, lastTick }) {
		for (const chunk of this.receiversQuery.iter()) {
			const healths = chunk.componentData[health]
			const buffers = chunk.componentData[collisionBuffer]
			const states = chunk.componentData[lifecycleState]

			for (let i = 0; i < chunk.size; i++) {
				// Only process entities that are currently active.
				if ((states.flags[i] & LIFECYCLE.ACTIVE) === 0) continue

				const collisionCount = buffers.count[i]
				if (collisionCount === 0) continue

				let accumulatedDamage = 0

				const events = [
					buffers.event0, buffers.event1, buffers.event2, buffers.event3,
					buffers.event4, buffers.event5, buffers.event6, buffers.event7,
				]

				// Accumulate damage from all collisions in this frame.
				for (let j = 0; j < collisionCount; j++) {
					const damagerEntityId = events[j][i]

					// Check if the colliding entity can deal damage. This is a remote access, but necessary.
					const damager = this.getComponent(damagerEntityId, damage)
					if (damager && damager.value > 0) {
						accumulatedDamage += damager.value
					}
				}

				// If any damage was accumulated, apply it once.
				if (accumulatedDamage > 0) {
					const newHealth = healths.current[i] - accumulatedDamage
					this.healthUpdateMutators.health.current[0] = newHealth
					this.healthUpdateMutators.health.max[0] = healths.max[i] // Must provide all fields
					this.setComponentData(chunk.entities[i], this.healthUpdatePayload)
				}
			}
		}
	}
}