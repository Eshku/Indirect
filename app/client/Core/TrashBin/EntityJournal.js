import { MASK_PARTS } from '../EntityManager/EntityManager.js'

//! Cancelled.

/**
 * The maximum number of events the journal can hold before the circular buffer
 * wraps around. An "event" is a single component change (modified, added, or removed).
 * This capacity is set to be very large to make it practically impossible for the
 * main `logic -> visuals` loop to miss events.
 */
const JOURNAL_CAPACITY = 65536 // can hold ~65k events before wrapping

export const JournalEvent = {
	MODIFIED: 0,
	ADDED: 1,
	REMOVED: 2,
}

export class EntityJournal {
	constructor() {
		this.journal = {
			writeCursor: new BigUint64Array(new SharedArrayBuffer(8)),
			sequences: new BigUint64Array(new SharedArrayBuffer(JOURNAL_CAPACITY * 8)),
			ticks: new Uint32Array(new SharedArrayBuffer(JOURNAL_CAPACITY * 4)),
			entityIds: new BigUint64Array(new SharedArrayBuffer(JOURNAL_CAPACITY * 8)),
			componentIds: new Uint16Array(new SharedArrayBuffer(JOURNAL_CAPACITY * 2)),
			types: new Uint8Array(new SharedArrayBuffer(JOURNAL_CAPACITY * 1)),
			JOURNAL_CAPACITY,
		}
		// Initialize cursors and sequences
		Atomics.store(this.journal.writeCursor, 0, 0n)
		// Initialize sequences to a value that guarantees a reader for sequence `s`
		// will wait until `sequences[s % cap]` is updated to `s`.
		for (let i = 0; i < JOURNAL_CAPACITY; i++) {
			this.journal.sequences[i] = BigInt(i - JOURNAL_CAPACITY)
		}
	}

	async init(engine) {
		this.workerManager = engine.workerManager
		this.workerManager.addInitialResource('journal', this.getSharedData())
	}

	getSharedData() {
		return {
			writeCursor: this.journal.writeCursor.buffer,
			sequences: this.journal.sequences.buffer,
			ticks: this.journal.ticks.buffer,
			entityIds: this.journal.entityIds.buffer,
			componentIds: this.journal.componentIds.buffer,
			types: this.journal.types.buffer,
			JOURNAL_CAPACITY,
		}
	}

	/**
	 * Writes an event to the journal. This is the core "reserve-write-publish" method.
	 * It's thread-safe and can be called from the main thread or any worker.
	 *
	 * The use of an infinitely-incrementing `writeCursor` and the `sequences` array
	 * makes this process safe even when the circular buffer index wraps around. A reader
	 * always checks against the absolute sequence number, preventing any ambiguity.
	 *
	 * @param {number} tick The current game tick.
	 * @param {bigint} entityId The ID of the entity that changed.
	 * @param {number} componentId The type ID of the component that changed.
	 * @param {number} type The type of change (e.g., JournalEvent.MODIFIED).
	 */
	writeEvent(tick, entityId, componentId, type) {
		// 1. Atomically reserve a slot to get a unique sequence number.
		const sequence = Atomics.add(this.journal.writeCursor, 0, 1n)

		// 2. Calculate the index in the circular buffer.
		const index = Number(sequence % BigInt(JOURNAL_CAPACITY))

		// 3. Write data to the reserved slot. This is contention-free.
		this.journal.ticks[index] = tick
		this.journal.entityIds[index] = entityId
		this.journal.componentIds[index] = componentId
		this.journal.types[index] = type

		// 4. Publish the event by writing its sequence number. This makes it visible to readers.
		Atomics.store(this.journal.sequences, index, sequence)
	}

	/**
	 * Writes a structural change event to the journal for each component in a mask.
	 * @param {number} tick The current game tick.
	 * @param {bigint} entityId The ID of the entity that changed.
	 * @param {BigUint64Array} componentMask The mask of components added or removed.
	 * @param {number} type The type of change (JournalEvent.ADDED or JournalEvent.REMOVED).
	 */
	writeStructuralEvent(tick, entityId, componentMask, type) {
		for (let part = 0; part < MASK_PARTS; part++) {
			for (let bit = 0; bit < 64; bit++) {
				if ((componentMask[part] & (1n << BigInt(bit))) !== 0n) {
					const componentId = part * 64 + bit
					this.writeEvent(tick, entityId, componentId, type)
				}
			}
		}
	}
}

export const entityJournal = new EntityJournal()