const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()

const { SharedCooldowns } = componentManager.getComponents()

/**
 * Manages the progression of cooldowns for all entities.
 * This system runs on a fixed timestep to ensure deterministic cooldown reduction.
 */
export class CooldownSystem {
	constructor() {
		this.query = queryManager.getQuery({
			with: [SharedCooldowns],
		})
		this.sharedCooldownsTypeID = componentManager.getComponentTypeID(SharedCooldowns)
	}

	update(deltaTime, currentTick) {
		for (const chunk of this.query.iter()) {
			const archetypeData = chunk.archetype
			const cooldownsMarker = archetypeManager.getDirtyMarker(archetypeData.id, this.sharedCooldownsTypeID, currentTick)
			// This is a "cold" component, so the array holds direct object instances.
			const sharedCooldownsArr = archetypeData.componentArrays[this.sharedCooldownsTypeID]

			for (const entityIndex of chunk) {
				const sharedCooldowns = sharedCooldownsArr[entityIndex]
				const cooldowns = sharedCooldowns.cooldowns

				if (cooldowns.size === 0) {
					continue
				}

				for (const [prefabId, remainingTime] of cooldowns.entries()) {
					const newRemainingTime = remainingTime - deltaTime

					if (newRemainingTime <= 0) {
						cooldowns.delete(prefabId)
					} else {
						cooldowns.set(prefabId, newRemainingTime)
					}
				}

				// If we processed any cooldowns, the component's internal state has changed.
				cooldownsMarker.mark(entityIndex)
			}
		}
	}
}
