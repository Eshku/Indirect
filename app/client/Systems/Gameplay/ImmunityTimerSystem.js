const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { immunity } = ecs.getComponentIDs()

/**
 * Ticks down the timer for active 'immunity' effects and disables them when they expire.
 * This separates the timing logic from any visual effects associated with immunity.
 */
export class ImmunityTimerSystem {
	static dependencies = {
		update: {
			reads: [immunity],
			writes: [immunity],
		},
	}

	init() {
		this.query = this.getQuery({
			with: [immunity],
		})
		this.scratchBuffer = this.getScratchBuffer(immunity)
	}

	update({ deltaTime }) {
		for (const chunk of this.query.iter()) {
			const immunities = chunk.componentData[immunity]

			const enabledCount = chunk.getEnabledIndices(immunity, this.scratchBuffer)

			for (let i = 0; i < enabledCount; i++) {
				const indexInChunk = this.scratchBuffer[i]

				const newTime = Math.max(0, immunities.timer[indexInChunk] - deltaTime)
				immunities.timer[indexInChunk] = newTime

				if (newTime === 0) {
					chunk.disableComponent(indexInChunk, immunity)
				}
			}
		}
	}
}