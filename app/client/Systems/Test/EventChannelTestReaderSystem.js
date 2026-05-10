import { engine } from '@client/Engine.js'
const { ecs, eventManager } = engine.getManagers()
const { EventChannelTestWriterSystem } = ecs.getSystemIDs()

const { testEvents } = ecs.getEvents()


/**
 * A simple system to test reading from an InstantEventChannel.
 * It runs after the writer system to ensure events are available.
 */
export class EventChannelTestReaderSystem {
	// Ensure this system runs after the writer to see the events in the same frame.
	static runsAfter = [EventChannelTestWriterSystem]

	init() {
		// Retrieve the channel registry and get a direct reference to the channel's buffer for reading.

		this.testChannelBuffer = testEvents.buffer
	}

	update({ currentTick }) {
		const { count, value, tick } = this.testChannelBuffer
		// The scheduler guarantees that all writer systems have completed before this
		// reader system runs. Therefore, the `count` value is stable for this frame,
		// and a direct, non-atomic read is safe, more performant, and sufficient.
		const eventCount = count[0]

		// Only log once every 60 ticks to reduce console spam.
		if (currentTick > 0 && currentTick % 60 === 0 && eventCount > 0) {
			console.log(`  [Reader] Reading ${eventCount} events at tick ${currentTick}:`)
			for (let i = 0; i < eventCount; i++) {
				console.log(`    - Event ${i}: { value: ${value[i]}, tick: ${tick[i]} }`)
			}
		}
	}
}
