const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { weaponCooldown } = ecs.getTypeIDs()

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
	}

	update({ deltaTime, currentTick }) {
		for (const chunk of this.query.iter()) {
			const timers = chunk.componentData[weaponCooldown].timer
			const dirtyTicks = chunk.dirtyTicks[weaponCooldown]
			let wasModified = false

			for (let i = 0; i < chunk.size; i++) {
				if (timers[i] > 0) {
					timers[i] = Math.max(0, timers[i] - deltaTime)
					dirtyTicks[i] = currentTick
					wasModified = true
				}
			}

			if (wasModified) chunk.markChunkDirty(weaponCooldown, currentTick)
		}
	}
}