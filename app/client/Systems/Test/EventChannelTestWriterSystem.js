import { engine } from '@client/Engine.js'
const { ecs } = engine.getManagers()

const { testEvents } = ecs.getEvents()

/**
 * A simple system to test writing to an InstantEventChannel.
 */
export class EventChannelTestWriterSystem {
	BATCH_CAPACITY = 10
	
	init() {
		// Retrieve the channel registry and destructure the specific channel we need.
		// This is type-safe and avoids magic strings.

		this.batch = testEvents.createBatch(this.BATCH_CAPACITY)
	}

	update({ currentTick }) {
		// On each frame, create a variable number of events to simulate a real-world scenario
		// where the number of events is not constant.
		const eventsToCreate = (currentTick % this.BATCH_CAPACITY) + 1

		// Populate only the portion of the batch buffer that we need for this frame.
		for (let i = 0; i < eventsToCreate; i++) {
			const value = Math.floor(Math.random() * 100)
			this.batch.value[i] = value
			this.batch.tick[i] = currentTick
		}

		// Push the batch, explicitly telling the channel how many events are valid.
		testEvents.pushBatch(this.batch, eventsToCreate)

		// Only log once every 60 ticks to reduce console spam.
		if (currentTick > 0 && currentTick % 60 === 0) {
			console.log(`[Writer] Pushed batch of ${eventsToCreate} events at tick ${currentTick}`)
		}
	}
}
