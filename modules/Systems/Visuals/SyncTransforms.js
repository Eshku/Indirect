const { componentManager } = await import(`${PATH_MANAGERS}/ComponentManager/ComponentManager.js`)
const { queryManager } = await import(`${PATH_MANAGERS}/QueryManager/QueryManager.js`)

const { Viewable, Position, Rotation, Scale } = componentManager.getComponents()

export class SyncTransforms {
	constructor() {
		this.positionQuery = queryManager.getQuery({
			with: [Viewable],
			react: [Position],
		})
		this.rotationQuery = queryManager.getQuery({
			with: [Viewable],
			react: [Rotation],
		})
		this.scaleQuery = queryManager.getQuery({
			with: [Viewable],
			react: [Scale],
		})

		// Cache component type IDs for performance inside the loop.
		this.viewableTypeID = componentManager.getComponentTypeID(Viewable)
		this.positionTypeID = componentManager.getComponentTypeID(Position)
		this.rotationTypeID = componentManager.getComponentTypeID(Rotation)
		this.scaleTypeID = componentManager.getComponentTypeID(Scale)
	}


	update(deltaTime, currentTick, lastTick) {
		// --- Position Sync ---
		for (const chunk of this.positionQuery.iter()) {
			const archetype = chunk.archetype
			// --- Direct Data Access: Get raw arrays once per chunk ---
			const viewableArrays = archetype.componentArrays[this.viewableTypeID]
			const positionArrays = archetype.componentArrays[this.positionTypeID]

			// Hoist property access out of the loop for minor performance gain.
			const posX = positionArrays.x
			const posY = positionArrays.y

			for (const entityIndex of chunk) {
				if (this.positionQuery.hasChanged(archetype, entityIndex)) {
					const view = viewableArrays[entityIndex]?.view
					if (!view) continue

					view.x = posX[entityIndex]
					view.y = -posY[entityIndex] // Invert Y for screen coordinates
				}
			}
		}

		// --- Rotation Sync ---
		for (const chunk of this.rotationQuery.iter()) {
			const archetype = chunk.archetype
			// --- Direct Data Access: Get raw arrays once per chunk ---
			const viewableArrays = archetype.componentArrays[this.viewableTypeID]
			const rotationArrays = archetype.componentArrays[this.rotationTypeID]

			// Hoist property access out of the loop.
			const angle = rotationArrays.angle

			for (const entityIndex of chunk) {
				if (this.rotationQuery.hasChanged(archetype, entityIndex)) {
					const view = viewableArrays[entityIndex]?.view
					if (!view) continue
					view.rotation = angle[entityIndex]
				}
			}
		}

		// --- Scale Sync ---
		for (const chunk of this.scaleQuery.iter()) {
			const archetype = chunk.archetype
			// --- Direct Data Access: Get raw arrays once per chunk ---
			const viewableArrays = archetype.componentArrays[this.viewableTypeID]
			const scaleArrays = archetype.componentArrays[this.scaleTypeID]

			// Hoist property access out of the loop.
			const scaleX = scaleArrays.x
			const scaleY = scaleArrays.y

			for (const entityIndex of chunk) {
				if (this.scaleQuery.hasChanged(archetype, entityIndex)) {
					const view = viewableArrays[entityIndex]?.view
					if (!view) continue
					view.scale.set(scaleX[entityIndex], scaleY[entityIndex])
				}
			}
		}
	}
}
