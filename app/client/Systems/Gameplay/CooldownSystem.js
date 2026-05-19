const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { weaponCooldown } = ecs.getComponentIDs()

/**
 * A generic system that decrements all cooldown timers.
 */
export class CooldownSystem {
	static dependencies = {
		update: {
			writes: [weaponCooldown],
		},
	}

	init() {
		this.query = this.getQuery({
			with: [weaponCooldown],
		})
		this.scratchBuffer = this.createScratchBuffer()
	}

	update({ deltaTime }) {
		const chunkIds = this.query.getChunks()
		for (let i = 0; i < chunkIds.length; i++) {
			const chunkId = chunkIds[i]
			const timers = this.getComponentData(chunkId, weaponCooldown).timer
			const enabledCount = this.getEnabled(chunkId, weaponCooldown, this.scratchBuffer)

			// Only iterate over entities whose cooldown component is enabled.
			for (let j = 0; j < enabledCount; j++) {
				const indexInChunk = this.scratchBuffer[j]

				timers[indexInChunk] = Math.max(0, timers[indexInChunk] - deltaTime)
				if (timers[indexInChunk] <= 0) {
					// The cooldown has finished. Disable the component so we don't
					// process it again until it's reset.
					this.disableComponent(chunkId, indexInChunk, weaponCooldown)
				}
			}
		}
	}
}
