const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager } = theManager.getManagers()

const { ReactivityTarget, ReactivityComponent, ComponentA, ComponentB } = componentManager.getComponents()

/**
 * A system to test the engine's reactivity pipeline, including direct component
 * modifications and structural changes (adding/removing components).
 */
export class ReactivityTestSystem {
	constructor() {
		// isolate specific tests.
		this.testConfig = {
			runDirectModificationTest: true,
			runStructuralChangeTest: false,
		}

		// --- Queries ---
		// Query for entities to modify. We need ReactivityComponent to modify its value.
		this.modificationTargetQuery = queryManager.getQuery({
			with: [ReactivityTarget, ReactivityComponent],
		})

		// Reactive query that detects changes to ReactivityComponent
		this.detectionQuery = queryManager.getQuery({
			with: [ReactivityTarget, ReactivityComponent], // Ensure we can read the value
			react: [ReactivityComponent],
		})

		// --- Component Type IDs ---
		this.reactivityComponentTypeID = componentManager.getComponentTypeID(ReactivityComponent)
		this.reactivityTargetTypeID = componentManager.getComponentTypeID(ReactivityTarget)
		this.componentATypeID = componentManager.getComponentTypeID(ComponentA)
		this.componentBTypeID = componentManager.getComponentTypeID(ComponentB)

		// --- Test State ---
		this.totalEntities = 10
		this.entitiesInitialized = false
		this.directModificationEntityId = null
		this.structuralChangeEntityId = null
	}

	init() {
		const creationMap = new Map([
			[this.reactivityTargetTypeID, {}],
			[this.reactivityComponentTypeID, { value: 0 }],
		])

		for (let i = 0; i < this.totalEntities; i++) {
			this.commands.createEntity(creationMap)
		}
		//console.log(`ReactivityTestSystem: Spawned ${this.totalEntities} test entities.`)
	}

	_initializeEntities() {
		const allEntities = []
		// Use the broader query to find all test entities, even if their components change.
		for (const chunk of this.modificationTargetQuery.iter()) {
			//console.log(`ReactivityTestSystem: Found ${chunk.size} test entities.`)
			for (let i = 0; i < chunk.size; i++) {
				//console.log(`ReactivityTestSystem: Found test entity ${chunk.entities[i]}`)
				allEntities.push(chunk.entities[i])
			}
		}
		//console.log(allEntities.length)
		if (allEntities.length >= 2) {
			// We'll use two separate entities for our tests to keep them isolated.
			this.directModificationEntityId = allEntities[0]
			this.structuralChangeEntityId = allEntities[1]
			this.entitiesInitialized = true
			console.log(
				`ReactivityTestSystem: Direct mod target: ${this.directModificationEntityId}, Structural change target: ${this.structuralChangeEntityId}`
			)
		}
	}

	update(deltaTime, currentTick, lastTick) {
		if (!this.entitiesInitialized) {
			// On the first update after init, the entities will have been created.
			this._initializeEntities()
			// If we still can't find them, wait for the next tick.
			if (!this.entitiesInitialized) return
		}

		if (this.testConfig.runDirectModificationTest) {
			this._runDirectModificationTest(currentTick)
		}

		if (this.testConfig.runStructuralChangeTest) {
			this._runStructuralChangeTest(currentTick)
		}

		this._runDetection(currentTick, lastTick)
	}

	_runDirectModificationTest(currentTick) {
		// Every 60 ticks, modify the `value` of one entity's ReactivityComponent.
		if (currentTick > 0 && currentTick % 60 === 0) {
			for (const chunk of this.modificationTargetQuery.iter()) {
				const reactComps = chunk.componentArrays[this.reactivityComponentTypeID]
				const marker = chunk.getDirtyMarker(this.reactivityComponentTypeID, currentTick)

				for (let i = 0; i < chunk.size; i++) {
					const entityId = chunk.entities[i]
					if (entityId === this.directModificationEntityId) {
						const oldValue = reactComps.value[i]
						const newValue = oldValue + 1
						reactComps.value[i] = newValue
						marker.mark(i)

						console.log(
							`%cReactivityTestSystem (Trigger): Modified ReactivityComponent on entity ${entityId}. Changed value from ${oldValue} to ${newValue} at tick ${currentTick}.`,
							'color: orange'
						)
						return // Found and modified
					}
				}
			}
		}
	}

	_runStructuralChangeTest(currentTick) {
		// At specific ticks, add or remove a component to test if the archetype change
		// correctly avoids triggering reactivity on other components.
		if (currentTick === 180) {
			console.log(
				`%cReactivityTestSystem (Structural): Adding ComponentA to entity ${this.structuralChangeEntityId} at tick ${currentTick}.`,
				'color: cyan'
			)
			this.commands.addComponent(this.structuralChangeEntityId, this.componentATypeID)
		} else if (currentTick === 240) {
			console.log(
				`%cReactivityTestSystem (Structural): Removing ComponentA from entity ${this.structuralChangeEntityId} at tick ${currentTick}.`,
				'color: magenta'
			)
			this.commands.removeComponent(this.structuralChangeEntityId, this.componentATypeID)
		}
	}

	_runDetection(currentTick, lastTick) {
		// This runs every frame to see what changes the reactive query has picked up.
		for (const chunk of this.detectionQuery.iter()) {
			const reactComps = chunk.componentArrays[this.reactivityComponentTypeID]

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				// hasChanged() is the key to reactivity.
				if (this.detectionQuery.hasChanged(chunk, indexInChunk)) {
					const entityId = chunk.entities[indexInChunk]
					const newValue = reactComps.value[indexInChunk]
					const dirtyTick = chunk.dirtyTicksArrays[this.reactivityComponentTypeID][indexInChunk]

					console.log(
						`%cReactivityTestSystem (Detector): Detected change on entity ${entityId}! New value: ${newValue}. (System last ran at ${lastTick}, component dirtied at ${dirtyTick})`,
						'color: lightgreen'
					)
				}
			}
		}
	}
}
