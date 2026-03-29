const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { rotation, spinning, isPooled } = ecs.getTypeIDs()
const { SyncTransforms } = ecs.getSystemIDs()

/**
 * This system is responsible for applying a constant rotation to entities
 * that have the `Spinning` component.
 */
export class SpinningSystem {
	static runsBefore = [SyncTransforms]

	static dependencies = {
		update: {
			reads: [spinning],
			writes: [rotation],
		},
	}

	init() {
		this.query = this.getQuery({
			with: [rotation, spinning],
			without: [isPooled],
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