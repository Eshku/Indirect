const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { describe, it, expect } = await import(`@managers/TestManager/TestAPI.js`)

const { reactivityComponent, reactivityTarget } = ecs.getComponentIDs()

/**
 * A test system that runs in the Logic group and directly marks a component as dirty.
 * This is used to test cross-group reactivity for direct writes.
 */
export class ReactivityCrossGroupWriterSystem {
	static dependencies = {
		update: {
			writes: [reactivityComponent],
		},
	}

	init() {
		this.hasWritten = false

		this.scratchBuffer = this.createScratchBuffer()


		this.testQuery = this.getQuery({ with: [reactivityTarget, reactivityComponent] })

		this.testPayload = this.compile({
			reactivityTarget: {},
			reactivityComponent: { value: 1 },
		})

		this.testEntityId = this.instantiateSilent(this.testPayload, 1)

		this.initialValue = 1
		this.valueToAssign = 2

		// Use the new silent creation method to avoid triggering reactivity on creation.
		// This ensures the test only validates the manual dirty marking in `update`.
		this.testEntityId = ecs.createEntitySilent({
			reactivityTarget: {}, // Tag to easily find this entity
			reactivityComponent: { value: this.initialValue },
		})

		// Reactive query to detect changes in reactivityComponent
		this.reactiveQuery = this.getQuery({
			with: [reactivityTarget, reactivityComponent],
			modified: [reactivityComponent],
		})
	}

	update({ lastVersion, currentVersion, frameCounter }) {
		this.entityLocation = ecs.getEntityLocation(this.testEntityId)

		if (!this.entityLocation) return // Wait for entity to be fully initialized

		const { chunkId, indexInChunk } = this.entityLocation
		const reactivity = this.getComponentData(chunkId, reactivityComponent)

		if (!this.hasWritten) {
			reactivity.value[indexInChunk] = this.valueToAssign // Increment value to ensure a change
			// With the new "Global Version" model, we mark with the currentVersion.
			// This is visible to subsequent systems in the same group and subsequent groups in the same frame.
			this.markEntityDirty(chunkId, indexInChunk, reactivityComponent, currentVersion)
			this.markComponentDirty(chunkId, reactivityComponent, currentVersion)
			this.hasWritten = true
			console.log(`%cWRITER LOGS:`, 'color: red; font-weight: bold;')
			console.log(`Frame ${frameCounter}: Wrote value ${this.valueToAssign} and marked for Version ${currentVersion}`)

			//! check if change is also detectable within same group.
			//! Test within single system simplifies check if logic system A writes + marks, System B - within same group - reads
			const changedChunks = this.reactiveQuery.getChunks()
			console.log(`Detected chunks within same system (writer) (Broad Phase):`)
			console.log(changedChunks)
			const dirtyCount = this.getDirty(chunkId, reactivityComponent, lastVersion, currentVersion, this.scratchBuffer)
			console.log(`Detected entities within same system (writer) (Narrow Phase): ${dirtyCount}`)


			//could also check quite frame there later.
		}
	}

	destroy() {
		if (this.testEntityId) {
			ecs.destroyEntity(this.testEntityId)
		}
	}
}
