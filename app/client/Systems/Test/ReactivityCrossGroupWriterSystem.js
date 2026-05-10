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

		this.testQuery = this.getQuery({ with: [reactivityTarget, reactivityComponent] })

		this.testEntityId = ecs.createEntity({
			reactivityTarget: {}, // Tag to easily find this entity
			reactivityComponent: { value: 0 },
		})
	}

	update({ currentTick }) {
		this.entityLocation = ecs.getEntityLocation(this.testEntityId)

		if (!this.entityLocation) return // Wait for entity to be fully initialized

		const { chunkId, indexInChunk } = this.entityLocation
		const reactivity = this.getComponentData(chunkId, reactivityComponent)

		if (!this.hasWritten) {
			reactivity.value[indexInChunk] = 1 // Increment value to ensure a change
			// Per reactivity goals, direct writes should be visible instantly.
			// We timestamp with the current tick (`T`) so systems running later in the same frame can see it.
			this.markEntityDirty(chunkId, indexInChunk, reactivityComponent, currentTick)
			this.markComponentDirty(chunkId, reactivityComponent, currentTick)
			this.hasWritten = true


			//const changedChunks = this.testQuery.getChunks()

			
		}
	}

	destroy() {
		if (this.testEntityId) {
			ecs.destroyEntity(this.testEntityId)
		}
	}
}
