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
		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ deltaTime }) {
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const immunities = this.getComponentData(chunkId, immunity)
			const entities = this.getEntities(chunkId)

			const enabledCount = this.getEnabled(chunkId, immunity, this.scratchBuffer)

			for (let j = 0; j < enabledCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				const newTime = Math.max(0, immunities.timer[indexInChunk] - deltaTime)
				immunities.timer[indexInChunk] = newTime

				if (newTime <= 0) {
					this.disableComponent(chunkId, indexInChunk, immunity)
				}
			}
		}
	}
}