//? rooms?
// not worth using it for entity events
// global doesn't really care about order, worst case scenario - can do simple priority based events
// doing whole order thing, inserting in order, shifting going to overcomplicate it for global events
// which just does not need that complexity.
//+ preferred to store ?whatever data structure on entity directly.

export class EventEmitter {
	constructor() {
		this.listeners = new Map() // event -> Map(id -> {callback, event})
		this.nextListenerId = 1
	}

	on(event, callback) {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Map())
		}

		const id = this.nextListenerId++
		this.listeners.get(event).set(id, { callback, event })
		return id
	}

	once(event, callback) {
		const id = this.on(event, (...args) => {
			callback(...args)
			this.off(id, event)
		})
		return id
	}

	emit(event, ...args) {
		const listeners = this.listeners.get(event)

		if (!listeners) return false

		for (const listenerData of listeners.values()) {
			listenerData.callback(...args)
		}

		return true
	}

	off(id, event) {
		if (event) {
			const listenersForEvent = this.listeners.get(event)
			if (listenersForEvent) {
				if (listenersForEvent.delete(id)) {
					if (listenersForEvent.size === 0) {
						this.listeners.delete(event)
					}
				}
			}
		} else {
			for (const [eventName, listenersForEvent] of this.listeners) {
				if (listenersForEvent.has(id)) {
					listenersForEvent.delete(id)
					if (listenersForEvent.size === 0) {
						this.listeners.delete(eventName)
					}
					return
				}
			}
		}
	}

	offAll(event) {
		event ? this.listeners.delete(event) : this.listeners.clear()
	}
}

export const eventEmitter = new EventEmitter()
window.eventEmitter = eventEmitter
