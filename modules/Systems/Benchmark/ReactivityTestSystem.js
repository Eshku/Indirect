const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, archetypeManager } = theManager.getManagers()

const { ReactivityTarget, ReactivityComponent } = componentManager.getComponents()


/**
 * A single system to test the entire reactivity pipeline.
 * It periodically modifies a component and then uses a separate reactive query
 * in the same frame to verify that the change is detected correctly.
 */
export class ReactivityTestSystem {
	constructor() {
		// Query to find entities to modify.
		this.modificationQuery = queryManager.getQuery({
			with: [ReactivityTarget, ReactivityComponent],
		})

		// Reactive query to detect the changes.
		this.detectionQuery = queryManager.getQuery({
			with: [ReactivityTarget],
			react: [ReactivityComponent],
		})

		this.reactivityComponentTypeID = componentManager.getComponentTypeID(ReactivityComponent)
		this.reactivityTargetTypeID = componentManager.getComponentTypeID(ReactivityTarget)

		this.entityToModifyIndex = 0
		this.totalEntities = 10
	}

	init() {
		// Spawn a few entities for testing.
		const creationMap = new Map([
			[this.reactivityTargetTypeID, {}],
			[this.reactivityComponentTypeID, { value: 0 }],
		])
		for (let i = 0; i < this.totalEntities; i++) {
			this.commands.createEntity(creationMap)
		}
		console.log(`ReactivityTestSystem: Spawned ${this.totalEntities} test entities.`)
	}

	update(deltaTime, currentTick, lastTick) {
		// --- 1. Trigger Phase ---
		// Once every 60 ticks (roughly once a second), modify one entity.
		if (currentTick > 0 && currentTick % 60 === 0) {
			// This loop is simple because we know all test entities are in one archetype.
			for (const chunk of this.modificationQuery.iter()) {
				const archetypeData = chunk.archetype
				const reactComps = archetypeData.componentArrays[this.reactivityComponentTypeID]

				// Get a marker for this archetype and component.
				const marker = archetypeManager.getDirtyMarker(archetypeData.id, this.reactivityComponentTypeID, currentTick)
				if (!marker) break // Component doesn't exist on archetype, should not happen with this query.

				// Ensure we don't go out of bounds if entities are somehow removed.
				const liveEntityCount = archetypeData.entityCount
				if (liveEntityCount === 0) break

				// Cycle through which entity to modify.
				this.entityToModifyIndex = this.entityToModifyIndex % liveEntityCount

				const entityId = archetypeData.entities[this.entityToModifyIndex]
				const oldValue = reactComps.value[this.entityToModifyIndex]
				const newValue = oldValue + 1
				reactComps.value[this.entityToModifyIndex] = newValue
				marker.mark(this.entityToModifyIndex)

				console.log(
					`%cReactivityTestSystem (Trigger): Modified entity ${entityId}. Changed value from ${oldValue} to ${newValue} at tick ${currentTick}.`,
					'color: orange'
				)

				this.entityToModifyIndex++
				break // Only modify one entity per trigger event.
			}
		}

		// --- 2. Detection Phase ---
		// This runs every frame to check for changes from the *previous* frame's systems
		// or changes made earlier in *this* system's update.
		for (const chunk of this.detectionQuery.iter()) {
			const archetypeData = chunk.archetype
			const reactComps = archetypeData.componentArrays[this.reactivityComponentTypeID]

			for (const entityIndex of chunk) {
				// The core of the test: does the reactive query detect the change?
				if (this.detectionQuery.hasChanged(archetypeData, entityIndex)) {
					const entityId = archetypeData.entities[entityIndex]
					const newValue = reactComps.value[entityIndex]
					const dirtyTick = archetypeManager.getDirtyTick(archetypeData.id, entityIndex, this.reactivityComponentTypeID)

					console.log(
						`%cReactivityTestSystem (Detector): Detected change on entity ${entityId}! New value: ${newValue}. (System last ran at tick ${lastTick}, component dirtied at tick ${dirtyTick})`,
						'color: lightgreen'
					)
				}
			}
		}
	}
}