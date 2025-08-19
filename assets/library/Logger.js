class Logger {
	static timers = new Map() // Store timers by label
	static warningColor = '#ffc107'
	static errorColor = '#dc3545'
	static timerColor = '#49d48f'
	static labelColor = '#39b376'

	static start(label) {
		if (this.timers.has(label)) {
			console.warn(`%cTimer "${label}" already exists. Overwriting.`, `color: ${this.warningColor}`)
		}
		this.timers.set(label, performance.now())
	}

	static end(label) {
		if (!this.timers.has(label)) {
			console.error(`%cTimer "${label}" not found.`, `color: ${this.errorColor}`)
			return
		}

		const startTime = this.timers.get(label)
		const endTime = performance.now()
		const duration = endTime - startTime

		console.log(`%c${label} - %c${this.formatTime(duration)}`, `color: ${this.labelColor}`, `color: ${this.timerColor}`)
		this.timers.delete(label)
	}

	static now(label = '') {
		console.log(`%c${label} ${this.formatTime(performance.now())}`, `color: ${this.timerColor}`)
	}

	static formatTime(timestamp) {
		const seconds = Math.floor(timestamp / 1000)
		const milliseconds = Math.floor(timestamp % 1000)
		return `${seconds}s ${milliseconds}ms`
	}
}
