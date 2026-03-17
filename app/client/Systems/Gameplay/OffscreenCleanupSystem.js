const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { enemyTag, playerTag, position, isPooled, lifecycleState, threatCost, spawnDirector } = ecs.getTypeIDs()

const LIFECYCLE = ecs.getConstantsForProperty('LifecycleState', 'flags')

// Define a large distance outside of which enemies will be culled.
// This should be significantly larger than the screen + spawn radius.
const CULLING_DISTANCE = 4000
const CULLING_DISTANCE_SQ = CULLING_DISTANCE * CULLING_DISTANCE

/**
 * A system that runs periodically to clean up enemies that are very far
 * from the player. This prevents an infinite accumulation of off-screen
 * entities, saving resources. Culled enemies have their threat cost
 * refunded to the SpawnDirector.
 */
export class OffscreenCleanupSystem {
	static dependencies = {
		// This system modifies the director's budget and marks entities for pooling.
		update: {
			reads: [position, threatCost, spawnDirector],
			writes: [lifecycleState, spawnDirector],
		},
	}

	init() {
		// Query for all active enemies that have a threat cost.
		this.enemyQuery = this.getQuery({
			with: [enemyTag, position, threatCost, lifecycleState],
			without: [isPooled],
		})

		// Singleton queries for the player and the director.
		this.playerQuery = this.getQuery({ with: [playerTag, position] })
		this.directorQuery = this.getQuery({ with: [spawnDirector] })

		this.playerId = this.playerQuery.getSingleEntity()
		this.directorId = this.directorQuery.getSingleEntity()

		// Pre-compile payloads for commands.
		const { payload: dyingPayload } = this.compile(lifecycleState, { flags: LIFECYCLE.DYING })
		this.dyingPayload = dyingPayload

		const { payload: directorPayload, mutators: directorMutators } = this.compile(spawnDirector)
		this.directorPayload = directorPayload
		this.directorMutators = directorMutators
	}

	update({ currentTick }) {
		const playerPos = this.getComponent(this.playerId, position)
		let totalRefund = 0

		for (const chunk of this.enemyQuery.iter()) {
			const positions = chunk.componentData[position]
			const costs = chunk.componentData[threatCost]
			const states = chunk.componentData[lifecycleState]

			for (let i = 0; i < chunk.size; i++) {
				if ((states.flags[i] & LIFECYCLE.ACTIVE) === 0) continue

				const dx = positions.x[i] - playerPos.x
				const dy = positions.y[i] - playerPos.y
				const distSq = dx * dx + dy * dy

				if (distSq > CULLING_DISTANCE_SQ) {
					totalRefund += costs.value[i]
					this.setComponentData(chunk.entities[i], this.dyingPayload)
				}
			}
		}

		if (totalRefund > 0) {
			const director = this.getComponent(this.directorId, spawnDirector)

			// We must provide all fields for the component when setting data.
			this.directorMutators.spawnDirector.threatBudget[0] = director.threatBudget + totalRefund
			this.directorMutators.spawnDirector.threatGrowthRate[0] = director.threatGrowthRate
			this.directorMutators.spawnDirector.maxThreatBudget[0] = director.maxThreatBudget
			this.directorMutators.spawnDirector.minSpawnBudget[0] = director.minSpawnBudget
			this.directorMutators.spawnDirector.threatGrowthEscalationRate[0] = director.threatGrowthEscalationRate
			this.setComponentData(this.directorId, this.directorPayload)
		}
	}
}
