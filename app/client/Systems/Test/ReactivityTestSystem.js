const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { reactivityTarget, reactivityComponent, componentA } = ecs.getTypeIDs()

/**
 * A pure test system for engine's core reactivity feature: broad-phase chunk culling.
 * It verifies that a reactive query only yields a chunk when its relevant component
 * has been explicitly marked as dirty for that chunk.
 */
export class ReactivityTestSystem {
	constructor() {
		// --- Test State ---
		this.entitiesInitialized = false
		this.testEntityId = null
	}

	init() {
		// --- Queries ---
		// A general query to find our test entity for modification.
		this.targetQuery = this.getQuery({
			with: [reactivityTarget, reactivityComponent],
		})

		// Reactive query we are testing. It should only yield a chunk
		// if `reactivityComponent` has been marked dirty in that chunk.
		this.detectionQuery = this.getQuery({
			with: [reactivityTarget, reactivityComponent],
			react: [reactivityComponent],
		})

		// --- Payloads ---
		this.componentAPayload = this.compile(componentA, {}).payload

		// Create a single entity for the test.
		const { payload } = this.compile({
			reactivityTarget: {},
			reactivityComponent: { value: 0 },
		})
		this.createEntity(payload)
	}

	_initializeEntities() {
		for (const chunk of this.targetQuery.iter()) {
			if (chunk.size > 0) {
				this.testEntityId = chunk.entities[0]
				this.entitiesInitialized = true
				console.log(`%cReactivityTestSystem: Initialized test entity ${this.testEntityId}.`, 'color: gray')
				return
			}
		}
	}

	update({ deltaTime, currentTick, lastTick }) {
		if (!this.entitiesInitialized) {
			this._initializeEntities()
		}

		// --- Trigger Phase ---
		// On tick 60, perform a modification that SHOULD be detected.
		if (currentTick === 60) {
			for (const chunk of this.targetQuery.iter()) {
				const reactComps = chunk.componentData[reactivityComponent]
				reactComps.value[0]++ // Modify the data

				// Use the core engine API to mark the component as dirty for the chunk.
				chunk.markDirty(reactivityComponent, currentTick)

				console.log(
					`%cReactivityTestSystem (Trigger): Modified ReactivityComponent at tick ${currentTick}.`,
					'color: orange',
				)
			}
		}

		// On tick 120, perform a structural change that should NOT be detected by this query.
		if (currentTick === 120) {
			this.addComponent(this.testEntityId, this.componentAPayload)
			console.log(
				`%cReactivityTestSystem (Structural): Added ComponentA at tick ${currentTick}.`,
				'color: #8e44ad',
			)
		}

		// --- Detection Phase ---
		this._runDetection(currentTick, lastTick)
	}

	_runDetection(currentTick, lastTick) {
		let detected = false
		for (const chunk of this.detectionQuery.iter()) {
			// If iterator yields anything, it means broad-phase check passed.
			detected = true
		}

		// We expect detection on the SAME frame as modification happens.
		if (currentTick === 60) {
			if (detected) {
				console.log(`%cReactivityTestSystem (Detector): PASSED! Detected direct modification on tick ${currentTick}.`, 'color: #2ecc71')
			} else {
				console.error(
					`%cReactivityTestSystem (Detector): FAILED! Did not detect change on tick ${currentTick}.`,
					'color: #e74c3c; font-weight: bold;',
				)
			}
		}
		// Structural change command is executed after tick 120's logic systems run.
		// So, we check for its (lack of) effect on the next frame, tick 121.
		else if (currentTick === 121) {
			if (!detected) {
				console.log(
					`%cReactivityTestSystem (Detector): PASSED! Correctly ignored structural change on tick ${currentTick}.`,
					'color: #2ecc71',
				)
			} else {
				console.error(
					`%cReactivityTestSystem (Detector): FAILED! Incorrectly detected structural change on tick ${currentTick}.`,
					'color: #e74c3c; font-weight: bold;',
				)
			}
		}
		// On any other frame where we didn't trigger a change, we expect no detection.
		else if (detected && currentTick !== 1) {
			// Ignore tick 1 as it might be part of initial creation.
			console.error(
				`%cReactivityTestSystem (Detector): FAILED! Detected a change on an unexpected tick: ${currentTick}.`,
				'color: #e74c3c; font-weight: bold;',
			)
		}
	}

	destroy() {
		// Clean up entities created by this test system to prevent accumulation on HMR.
		for (const chunk of this.targetQuery.iter()) {
			if (chunk.size > 0) this.destroyEntitiesInChunk(chunk)
		}
	}
}
