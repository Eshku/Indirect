const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()

const { reactivityComponent, componentA } = ecs.getComponentIDs()

/**
 * A test system that runs in the Logic group and queues a deferred `setComponent` command.
 * This is used to test cross-group reactivity for deferred writes, which are expected
 * to be visible on the NEXT frame.
 */
export class ReactivityCrossGroupDeferredWriterSystem {
	init() {
		// Defer entity creation to ensure all operations happen within the command buffer lifecycle.
		// This returns a placeholder ID. The reader system will find the real ID after the first flush.

		this.testEntityPayload = this.compile({
			componentA: {}, // Tag component to isolate this entity from other tests.
			reactivityComponent: { value: 1 },
		})

		this.testEntityId = null
	}

	update({ currentTick }) {
		//wait for a bit

		this.testEntityId = this.instantiate(this.testEntityPayload)

		// The command buffer will flush at the end of the logic tick, applying the
		// change and timestamping it with tick 26. The reader system, running in the
		// 'visuals' group, is expected to see this change in the same global frame.
	}
}
