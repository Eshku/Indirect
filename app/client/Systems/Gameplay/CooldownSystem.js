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
		this.scratchBuffer = this.getScratchBuffer(weaponCooldown)
	}

	update({ deltaTime, currentTick }) {
		for (const chunk of this.query.iter()) {
			const timers = chunk.componentData[weaponCooldown].timer
			const enabledCount = chunk.getEnabledIndices(weaponCooldown, this.scratchBuffer)

			// Only iterate over entities whose cooldown component is enabled.
			for (let i = 0; i < enabledCount; i++) {
				const indexInChunk = this.scratchBuffer[i]

				// This check is slightly redundant if components are always disabled
				// when the timer hits zero, but it's a good defensive measure.
				if (timers[indexInChunk] > 0) {
					timers[indexInChunk] = Math.max(0, timers[indexInChunk] - deltaTime)

					if (timers[indexInChunk] === 0) {
						// The cooldown has finished. Disable the component so we don't
						// process it again until it's reset.
						chunk.disableComponent(indexInChunk, weaponCooldown)
					}
				}
			}
		}
	}
}