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
		// The channel object itself now holds the shared data.
		// We can also access helper methods like getCount() from it.
		this.testChannel = testEvents
	}

	update({ currentVersion }) {
		// The scheduler guarantees that all writer systems have completed before this
		// reader system runs. Therefore, the `count` value is stable for this frame,
		// and a direct, non-atomic read is safe, more performant, and sufficient.
		// Use the new helper methods for a cleaner API.
		const eventCount = this.testChannel.getCount()

		// Only log once every 60 ticks to reduce console spam.
		if (currentVersion > 0 && currentVersion % 60 === 0 && eventCount > 0) {
			const { value, tick } = this.testChannel.getBuffers()
			console.log(`  [Reader] Reading ${eventCount} events at version ${currentVersion}:`)
			for (let i = 0; i < eventCount; i++) {
				console.log(`    - Event ${i}: { value: ${value[i]}, tick: ${tick[i]} }`)
			}
		}
	}
}
