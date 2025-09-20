const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { queryManager, componentManager, systemManager } = theManager.getManagers()
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

/**
 * A system to test the engine's reactivity pipeline, including direct component
 * modifications and structural changes (adding/removing components).
 */
export class ReactivityTestSystem {
	constructor() {
		// true \ false
		this.testConfig = {
			runDirectModificationTest: true,
			runStructuralChangeTest: false,
		}

		const { reactivityTarget, reactivityComponent, componentA, componentB } = componentManager.getTypeIDs()
		Object.assign(this, { reactivityTarget, reactivityComponent, componentA, componentB })

		// --- Queries ---
		// Query for entities to modify. We need ReactivityComponent to modify its value.
		this.modificationTargetQuery = queryManager.getQuery({
			with: [reactivityTarget, reactivityComponent],
		})

		// Reactive query that detects changes to ReactivityComponent
		this.detectionQuery = queryManager.getQuery({
			with: [reactivityTarget, reactivityComponent], // Ensure we can read the value
			react: [reactivityComponent],
		})

		// --- Test State ---
		this.totalEntities = 2
		this.entitiesInitialized = false
		this.directModificationEntityId = null
		this.structuralChangeEntityId = null

		// Pre-compile the payload for adding ComponentA. Since it's a tag, the data is empty.
		this.componentAPayload = payloadCompiler.compileComponent(this.componentA, {}).payload
	}

	init() {
		for (let i = 0; i < this.totalEntities; i++) {
			// Compile the payload once.
			const { payload } = payloadCompiler.compileEntity({
				ReactivityTarget: {},
				ReactivityComponent: { value: 0 },
			})
			this.commands.createEntity(payload)
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

		if (allEntities.length < 2) {
			console.warn(`ReactivityTestSystem: Not enough entities to run tests. Found ${allEntities.length}, need 2.`)
			return
		}

		// We'll use two separate entities for our tests to keep them isolated.
		this.directModificationEntityId = allEntities[0]
		this.structuralChangeEntityId = allEntities[1]
		this.entitiesInitialized = true
		/* console.log(
			`ReactivityTestSystem: Direct mod target: ${this.directModificationEntityId}, Structural change target: ${this.structuralChangeEntityId}`
		) */
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
				const reactComps = chunk.componentArrays[this.reactivityComponent]
				const marker = chunk.getDirtyMarker(this.reactivityComponent, currentTick)

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

			this.commands.addComponent(this.structuralChangeEntityId, this.componentAPayload)
		} else if (currentTick === 240) {
			console.log(
				`%cReactivityTestSystem (Structural): Removing ComponentA from entity ${this.structuralChangeEntityId} at tick ${currentTick}.`,
				'color: magenta'
			)
			this.commands.removeComponent(this.structuralChangeEntityId, this.componentA)
		}
	}

	_runDetection(currentTick, lastTick) {
		// This runs every frame to see what changes the reactive query has picked up.
		for (const chunk of this.detectionQuery.iter()) {
			const reactComps = chunk.componentArrays[this.reactivityComponent]

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				// hasChanged() is the key to reactivity.
				if (this.detectionQuery.hasChanged(chunk, indexInChunk)) {
					const entityId = chunk.entities[indexInChunk]
					const newValue = reactComps.value[indexInChunk]
					const dirtyTick = chunk.dirtyTicksArrays[this.reactivityComponent][indexInChunk]

					console.log(
						`%cReactivityTestSystem (Detector): Detected change on entity ${entityId}! New value: ${newValue}. (System last ran at ${lastTick}, component dirtied at ${dirtyTick})`,
						'color: lightgreen'
					)
				}
			}
		}
	}
}
