const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { rotation, spinning } = ecs.getTypeIDs()

/**
 * This system is responsible for applying a constant rotation to entities
 * that have the `Spinning` component.
 */
export class SpinningSystem {
	init() {
		this.query = this.getQuery({
			with: [rotation, spinning],
		})
	}

	update({ deltaTime, currentTick }) {
		for (const chunk of this.query.iter()) {
			const rotationArrays = chunk.componentData[rotation]
			const spinningArrays = chunk.componentData[spinning]

			const angle = rotationArrays.angle
			const rate = spinningArrays.rate

			for (let i = 0; i < chunk.size; i++) {
				angle[i] += rate[i] * deltaTime
			}
		}
	}
}