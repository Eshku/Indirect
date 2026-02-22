const { engine } = await import(`${PATH_CLIENT}/Engine.js`)
const { ecs } = engine.getManagers()
const { queryManager, entityManager } = ecs
const { payloadCompiler } = await import(`${PATH_ECS}/SystemManager/PayloadCompiler.js`)

/**
 * A system to test the engine's reactivity pipeline, including direct component
 * modifications and structural changes (adding/removing components).
 */
export class ReactivityTestSystem {
	static dependencies = {
		update: {
			reads: ['reactivityComponent'],
		},
	}

	constructor() {
		// true \ false
		this.testConfig = {
			runDirectModificationTest: true,
			runStructuralChangeTest: false,
		}

		const { reactivityTarget, reactivityComponent, componentA, componentB } = ecs.getTypeIDs()
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
		// Needs at least 2
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
	}

	_initializeEntities() {
		const allEntities = []
		// Use the broader query to find all test entities, even if their components change.
		for (const chunk of this.modificationTargetQuery.iter()) {
			// Iterate through the entities of the chunk and add them to the list.
			for (let i = 0; i < chunk.size; i++) allEntities.push(chunk.entities[i])
		}

		// We'll use two separate entities for our tests to keep them isolated.
		this.directModificationEntityId = allEntities[0]
		this.structuralChangeEntityId = allEntities[1]
		this.entitiesInitialized = true
	}

	update({deltaTime, currentTick, lastTick}) {
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

		this._runDetection(currentTick)
	}

	_runDirectModificationTest(currentTick) {
		// Every 60 ticks, modify the `value` of one entity's ReactivityComponent.
		if (currentTick > 0 && currentTick % 60 === 0) {
			for (const chunk of this.modificationTargetQuery.iter()) {
				const entities = chunk.entities
				const reactComps = chunk.componentData[this.reactivityComponent]

				for (let i = 0; i < chunk.size; i++) {
					if (entities[i] === this.directModificationEntityId) {
						const oldValue = reactComps.value[i]
						const newValue = oldValue + 1
						reactComps.value[i] = newValue
						chunk.markEntityDirty(this.reactivityComponent, i, currentTick)

						console.log(
							`%cReactivityTestSystem (Trigger): Modified ReactivityComponent on entity ${this.directModificationEntityId}. Changed value from ${oldValue} to ${newValue} at tick ${currentTick}.`,
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

	_runDetection(currentTick) {
		// This runs every frame to see what changes the reactive query has picked up.
		for (const chunk of this.detectionQuery.iter()) {
			const entities = chunk.entities
			const reactComps = chunk.componentData[this.reactivityComponent]
			const dirtyTicks = chunk.dirtyTicks[this.reactivityComponent]

			for (let indexInChunk = 0; indexInChunk < chunk.size; indexInChunk++) {
				// Use the new helper method for cleaner code.
				if (chunk.hasChanged(this.reactivityComponent, indexInChunk)) {
					const entityId = entities[indexInChunk]
					const newValue = reactComps.value[indexInChunk]
					const dirtyTick = dirtyTicks[indexInChunk]

					console.log(
						`%cReactivityTestSystem (Detector): Detected change on entity ${entityId}! New value: ${newValue}. (Component dirtied at ${dirtyTick})`,
						'color: lightgreen'
					)
				}
			}
		}
	}

	destroy() {
		// Clean up entities created by this test system to prevent accumulation on HMR.
		// Use the highly efficient chunk-based destruction command.
		for (const chunk of this.modificationTargetQuery.iter()) {
			if (chunk.size > 0) this.commands.destroyEntitiesInChunk(chunk)
		}
	}
}
