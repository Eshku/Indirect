const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)

// --- Constants for Configuration ---
const PANEL_UPDATE_INTERVAL_S = 0.5 // Seconds
const STATS_WINDOW_DURATION_S = 3.0 // Calculate stats over the last 3 seconds.
const BREACHING_THRESHOLD_MS = 15.0 // Threshold for a system time to be colored red.
const LIST_REFRESH_INTERVAL_S = 1.0 // How often to re-sort and select the top systems.
const WARNING_THRESHOLD_MS = 16.6 // ms, ~1 frame at 60fps. Log a console warning if breached.
const TOP_SYSTEMS_COUNT = 5 // How many of the slowest systems to show by default.

/**
 * A system that displays the execution time of other systems in a UI panel.
 * It reads timing data collected by the GameLoop and provides a stable, readable display
 * with average and max timings, filtering, and a clear layout.
 *
 * ---
 *
 * ### Developer Note: Features & Functionality
 *
 * This monitor is designed to be a comprehensive, non-intrusive tool for debugging performance.
 *
 * - **Data Collection**: It pulls raw timing data from `SystemManager.systemTimings` each frame.
 * - **Sliding Window**: It calculates `avg` and `max` execution times over a configurable `windowDuration` (e.g., 1 second)
 *   to provide a rolling, stable view of performance rather than noisy, per-frame numbers. * - **Top Systems**: By default, it shows only the top 5 slowest systems (by max execution time) to provide a clean,
 *   stable view of the most expensive operations. This can be toggled with the "Show all" checkbox to display all systems.
 * - **Pinning**: You can click on any system in the list to "pin" it. Pinned systems are always displayed at the top
 *   of the list in a separate group, sorted alphabetically. This is extremely useful for tracking a specific system's
 *   behavior without it being lost in the main list, which is sorted by `max` time.
 * - **Command Buffer**: The `CommandBuffer.flush` operation is displayed separately at the top, as its performance
 *   is critical and distinct from other systems.
 * - **Frame Summary**: A total of all system `avg` and `max` times is displayed at the bottom, giving a rough
 *   idea of the total frame cost from the perspective of the ECS.
 */
export class PerformanceMonitor {
	constructor() {
		this.systemManager = null // Injected in init
		this.panel = null
		this.systemsListBody = null

		// --- DOM element references ---
		this.commandBufferElements = { container: null, name: null, avg: null, max: null, hr: null }
		this.rendererElements = { container: null, name: null, avg: null, max: null, hr: null }
		this.summaryElements = { container: null, name: null, avg: null, max: null, hr: null }
		this.memoryElements = { container: null, name: null, value: null, hr: null }
		this.systemRowElements = new Map()
		this.pinnedSeparator = null

		// --- State ---
		this.lastProcessedStats = null
		this.pinnedSystems = new Set() // Systems to always show at the top.
		this.topUnpinnedSystems = [] // Cache of system names to display in the unpinned list.

		// --- Timing & History ---
		this.timeAccumulator = 0
		this.listUpdateAccumulator = 0
		this.history = {}
		this.warnedSystems = new Set() // Track systems that have triggered a console warning.
	}

	init() {
		this.systemManager = theManager.getManager('SystemManager')
		this._createPanel()
		// @ts-ignore
		window.performanceMonitor = this
	}

	/**
	 * Injects a <style> block into the document head for the monitor's CSS.
	 * This keeps the component self-contained.
	 * @private
	 */
	_injectStyles() {
		const styleId = 'performance-monitor-styles'
		if (document.getElementById(styleId)) return

		const style = document.createElement('style')
		style.id = styleId
		style.innerHTML = `
            #performance-monitor .system-row.pinned { background-color: rgba(255, 255, 0, 0.1); }
            #performance-monitor .system-row.breaching { color: #ff6b6b; }
        `
		document.head.appendChild(style)
	}

	destroy() {
		// @ts-ignore
		if (window.performanceMonitor === this) {
			// @ts-ignore
			window.performanceMonitor = null
		}
		this.panel?.remove()
		this.panel = null
		this.commandBufferElements = null
		this.rendererElements = null
		this.summaryElements = null
		this.memoryElements = null
		this.systemRowElements = null
		this.pinnedSeparator = null
	}

	/**
	 * Public API to programmatically pin a system for tracking.
	 * Pinned systems are always visible at the top of the monitor.
	 * @param {string} systemName - The name of the system to pin.
	 */
	pin(systemName) {
		if (typeof systemName !== 'string' || !systemName) {
			console.warn('PerformanceMonitor.pin: Please provide a valid system name.')
			return
		}

		if (this.pinnedSystems.has(systemName)) return

		this.pinnedSystems.add(systemName)

		if (this.lastProcessedStats) this._renderSystemsList(this.lastProcessedStats)
	}

	/**
	 * Public API to programmatically un-pin a system.
	 * @param {string} systemName - The name of the system to unpin.
	 */
	unpin(systemName) {
		if (typeof systemName !== 'string' || !systemName) {
			console.warn('PerformanceMonitor.unpin: Please provide a valid system name.')
			return
		}

		if (!this.pinnedSystems.has(systemName)) return

		this.pinnedSystems.delete(systemName)

		if (this.lastProcessedStats) this._renderSystemsList(this.lastProcessedStats)
	}

	/**
	 * Public API to un-pin all currently tracked systems.
	 */
	unpinAll() {
		if (this.pinnedSystems.size === 0) {
			return
		}

		this.pinnedSystems.clear()

		if (this.lastProcessedStats) this._renderSystemsList(this.lastProcessedStats)
	}

	/**
	 * Returns a sorted list of all system names currently being tracked.
	 * This is useful for discovering system names to use with .pin().
	 * @returns {string[]} A sorted array of system names.
	 */
	getSystemNames() {
		return Object.keys(this.history).sort()
	}

	update(deltaTime) {
		// 1. Accumulate history from the SystemManager for this frame.
		this.listUpdateAccumulator += deltaTime
		const now = performance.now()
		for (const systemName in this.systemManager.systemTimings) {
			const time = this.systemManager.systemTimings[systemName]
			if (!this.history[systemName]) {
				this.history[systemName] = []
			}
			this.history[systemName].push({ time, timestamp: now })
		}

		// 2. Check if it's time to update the display.
		this.timeAccumulator += deltaTime
		if (this.timeAccumulator < PANEL_UPDATE_INTERVAL_S) return

		// 3. Process history and render all panels
		this._processAndUpdate()

		// 4. Reset for the next interval.
		this.timeAccumulator -= PANEL_UPDATE_INTERVAL_S
	}

	_processAndUpdate() {
		const { commandBufferStats, rendererStats, otherSystemsStats, totalAvg, totalMax } = this._calculateCurrentStats()

		// Cache the stats needed for immediate re-rendering on UI interaction (pinning, toggling).
		this.lastProcessedStats = otherSystemsStats

		// Render all sections with the new data.
		this._renderSpecialRow(commandBufferStats, this.commandBufferElements, 'CommandBuffer.flush', 'Command Buffer')
		this._renderSystemsList(otherSystemsStats)
		this._renderSpecialRow(rendererStats, this.rendererElements, 'Renderer.render', 'Render')
		this._renderSummary(totalAvg, totalMax)
		this._renderMemory()
	}

	/**
	 * Processes the timing history, prunes old data, and calculates avg/max stats for the current window.
	 * @returns {object} An object containing all calculated stats for the frame.
	 * @private
	 */
	_calculateCurrentStats() {
		const displayNow = performance.now()
		const windowStartTime = displayNow - STATS_WINDOW_DURATION_S * 1000
		const processedStats = {}

		for (const systemName in this.history) {
			const systemHistory = this.history[systemName]

			// Prune old entries. Use a while loop for efficiency.
			while (systemHistory.length > 0 && systemHistory[0].timestamp < windowStartTime) {
				systemHistory.shift()
			}

			if (systemHistory.length === 0) {
				// Clean up empty history arrays to prevent memory leaks if a system stops running.
				delete this.history[systemName]
				continue
			}

			// Calculate stats from the remaining (current window) history.
			let total = 0
			let max = 0
			for (const record of systemHistory) {
				total += record.time
				if (record.time > max) {
					max = record.time
				}
			}
			const avg = total / systemHistory.length

			processedStats[systemName] = { avg, max, count: systemHistory.length }
		}

		// Calculate summary stats. This includes the command buffer.
		let totalAvg = 0
		let totalMax = 0
		for (const systemName in processedStats) {
			totalAvg += processedStats[systemName].avg
			totalMax += processedStats[systemName].max // This is a sum of maxes, not a true max, but useful for a rough upper bound.
		}

		const commandBufferStats = processedStats['CommandBuffer.flush']
		const rendererStats = processedStats['Renderer.render']
		const otherSystemsStats = { ...processedStats }
		delete otherSystemsStats['CommandBuffer.flush']
		delete otherSystemsStats['Renderer.render']

		return { commandBufferStats, rendererStats, otherSystemsStats, totalAvg, totalMax }
	}

	/**
	 * Generic renderer for special, always-visible rows like CommandBuffer and Renderer.
	 * @param {object} data - The stats object for the row.
	 * @param {object} elements - The DOM elements for the row.
	 * @param {string} systemName - The internal name of the system for warning tracking.
	 * @param {string} displayName - The user-facing name to display.
	 * @private
	 */
	_renderSpecialRow(data, elements, systemName, displayName) {
		const { container, avg, max, hr } = elements
		if (!container) return

		if (!data || data.count === 0) {
			container.style.display = 'none'
			if (hr) hr.style.display = 'none'
			return
		}

		container.style.display = 'flex'
		if (hr) hr.style.display = 'block'

		const isBreaching = data.max >= BREACHING_THRESHOLD_MS
		const isWarning = data.max >= WARNING_THRESHOLD_MS

		if (isWarning) {
			if (!this.warnedSystems.has(systemName)) {
				console.warn(
					`%cPerformance Warning:%c System '${displayName}' breached ${WARNING_THRESHOLD_MS.toFixed(
						1
					)}ms threshold. Max time: ${data.max.toFixed(3)}ms`,
					'color: yellow; font-weight: bold;',
					'color: white;'
				)
				this.warnedSystems.add(systemName)
			}
		} else if (this.warnedSystems.has(systemName)) {
			this.warnedSystems.delete(systemName)
		}

		container.classList.toggle('breaching', isBreaching)
		avg.textContent = data.avg.toFixed(3)
		max.textContent = data.max.toFixed(3)
	}

	_updateSystemRow(rowElements, system) {
		const { name, avg, max } = system
		const { container, name: nameEl, avg: avgEl, max: maxEl } = rowElements

		const isBreaching = max >= BREACHING_THRESHOLD_MS
		const isWarning = max >= WARNING_THRESHOLD_MS
		const isPinned = this.pinnedSystems.has(name)

		if (isWarning) {
			if (!this.warnedSystems.has(name)) {
				console.warn(
					`%cPerformance Warning:%c System '${name}' breached ${WARNING_THRESHOLD_MS.toFixed(
						1
					)}ms threshold. Max time: ${max.toFixed(3)}ms`,
					'color: yellow; font-weight: bold;',
					'color: white;'
				)
				this.warnedSystems.add(name)
			}
		} else if (this.warnedSystems.has(name)) {
			// If the system is no longer breaching, remove it so it can warn again if it spikes later.
			this.warnedSystems.delete(name)
		}

		container.dataset.systemName = name
		container.title = `${name} (Click to ${isPinned ? 'unpin' : 'pin'})`
		container.classList.toggle('pinned', isPinned)
		container.classList.toggle('breaching', isBreaching)

		nameEl.textContent = name
		avgEl.textContent = avg.toFixed(3)
		maxEl.textContent = max.toFixed(3)
	}

	_renderSystemsList(systemsStats) {
		if (!this.systemsListBody) return

		const { pinned, unpinnedToDisplay } = this._getDisplayedSystems(systemsStats)
		this._reconcileSystemRows(pinned, unpinnedToDisplay)
	}

	/**
	 * Filters and sorts all system stats into pinned and unpinned lists for display.
	 * Implements the "stable list" logic to prevent UI jitter.
	 * @param {object} systemsStats - The raw stats object for all systems.
	 * @returns {{pinned: object[], unpinnedToDisplay: object[]}}
	 * @private
	 */
	_getDisplayedSystems(systemsStats) {
		const allSystems = Object.entries(systemsStats).map(([name, data]) => ({ name, avg: data.avg, max: data.max }))

		const pinned = []
		const unpinned = []

		for (const system of allSystems) {
			if (this.pinnedSystems.has(system.name)) {
				pinned.push(system)
			} else {
				unpinned.push(system)
			}
		}

		// Sort for stability and clarity
		pinned.sort((a, b) => a.name.localeCompare(b.name))

		let unpinnedToDisplay
		const shouldUpdateList = this.listUpdateAccumulator >= LIST_REFRESH_INTERVAL_S

		if (shouldUpdateList) {
			this.listUpdateAccumulator -= LIST_REFRESH_INTERVAL_S
			// Sort all unpinned systems by their average time to find the new top N.
			unpinned.sort((a, b) => b.avg - a.avg)
			unpinnedToDisplay = unpinned.slice(0, TOP_SYSTEMS_COUNT)
			// Cache the names of these top systems for the next few frames.
			this.topUnpinnedSystems = unpinnedToDisplay.map(s => s.name)
		} else {
			// On intermediate frames, use the cached list of names to get the current data.
			const currentUnpinnedStatsMap = new Map(unpinned.map(s => [s.name, s]))
			unpinnedToDisplay = this.topUnpinnedSystems
				.filter(name => !this.pinnedSystems.has(name)) // Exclude systems that were just pinned.
				.map(name => {
					const stats = currentUnpinnedStatsMap.get(name)
					// If a system from our cached top list has no stats this frame (e.g., it stopped running),
					// create a dummy object so it still gets rendered, preventing the list from shrinking and causing "missed clicks".
					return stats || { name, avg: 0, max: 0 }
				})
		}
		return { pinned, unpinnedToDisplay }
	}

	/**
	 * Updates the DOM to reflect the desired list of systems.
	 * It creates, removes, updates, and re-orders system rows efficiently.
	 * @param {object[]} pinned - Array of pinned systems to display.
	 * @param {object[]} unpinnedToDisplay - Array of top unpinned systems to display.
	 * @private
	 */
	_reconcileSystemRows(pinned, unpinnedToDisplay) {
		const displayedSystems = [...pinned, ...unpinnedToDisplay]
		const activeSystemNames = new Set(displayedSystems.map(s => s.name))

		// Update or create rows for systems that should be displayed
		for (const system of displayedSystems) {
			let row = this.systemRowElements.get(system.name)
			if (!row) {
				row = this._createSystemRow()
				this.systemRowElements.set(system.name, row)
			}
			this._updateSystemRow(row, system)
		}

		// Remove rows for systems that are no longer displayed
		for (const [name, row] of this.systemRowElements.entries()) {
			if (!activeSystemNames.has(name)) {
				row.container.remove()
				this.systemRowElements.delete(name)
			}
		}

		const body = this.systemsListBody
		const desiredNodes = []

		pinned.forEach(s => desiredNodes.push(this.systemRowElements.get(s.name).container))

		if (pinned.length > 0 && unpinnedToDisplay.length > 0) {
			this.pinnedSeparator.style.display = 'block'
			desiredNodes.push(this.pinnedSeparator)
		} else {
			this.pinnedSeparator.style.display = 'none'
		}

		unpinnedToDisplay.forEach(s => desiredNodes.push(this.systemRowElements.get(s.name).container))

		// Reconcile the current DOM order with the desired order.
		let currentElement = body.firstChild
		desiredNodes.forEach(node => {
			if (currentElement === node) {
				currentElement = currentElement.nextSibling
			} else {
				body.insertBefore(node, currentElement)
			}
		})
	}

	_renderMemory() {
		const { container, value, hr } = this.memoryElements
		if (!container) return

		if (performance.memory) {
			container.style.display = 'flex'
			hr.style.display = 'block'

			const used = performance.memory.usedJSHeapSize / 1048576 // MB
			const total = performance.memory.jsHeapSizeLimit / 1048576 // MB
			value.textContent = `${used.toFixed(2)}MB / ${total.toFixed(2)}MB`
		} else {
			// Hide if performance.memory is not available
			container.style.display = 'none'
			hr.style.display = 'none'
		}
	}

	_renderSummary(totalAvg, totalMax) {
		const { container, avg, max, hr } = this.summaryElements
		if (!container) return

		// The total average time is a good indicator of overall frame cost.
		// If this breaches 15ms, it's a significant performance issue.
		const isBreaching = totalAvg >= BREACHING_THRESHOLD_MS

		if (totalAvg === 0 && totalMax === 0) {
			container.style.display = 'none'
			hr.style.display = 'none'
			return
		}

		container.style.display = 'flex'
		hr.style.display = 'block'

		container.classList.toggle('breaching', isBreaching)
		avg.textContent = totalAvg.toFixed(3)
		max.textContent = totalMax.toFixed(3)
	}

	_createPanel() {
		this.panel = this._createStyledElement('div', {
			position: 'absolute',
			left: '10px', // Consistent margin
			top: '10px', // Consistent margin
			padding: '10px',
			width: '280px',
			backgroundColor: 'rgba(0, 0, 0, 0.6)',
			color: 'white',
			fontFamily: 'Consolas, "Courier New", monospace',
			fontSize: '13px',
			lineHeight: '1.4',
			zIndex: '100',
			border: '1px solid #444',
			borderRadius: '4px',
		})
		this.panel.id = 'performance-monitor'

		this._injectStyles()

		// Title
		this.panel.appendChild(
			this._createStyledElement(
				'div',
				{
					fontWeight: 'bold',
					fontSize: '16px',
					textAlign: 'center',
					marginBottom: '10px',
					borderBottom: '1px solid #444',
					paddingBottom: '5px',
				},
				'Performance Monitor'
			)
		)

		// --- Create all sections first ---

		// Command Buffer Section
		const cbRow = this._createRowElements('<strong>Command Buffer</strong>')
		cbRow.container.classList.add('system-row')
		cbRow.container.title = 'CommandBuffer.flush'
		cbRow.container.style.display = 'none' // Initially hidden
		const cbHr = this._createStyledElement('hr', {
			borderColor: '#444',
			marginTop: '10px',
			marginBottom: '5px',
			display: 'none',
		})
		this.commandBufferElements = { ...cbRow, hr: cbHr }

		// Renderer Section
		const rHr = this._createStyledElement('hr', {
			borderColor: '#444',
			marginTop: '10px',
			marginBottom: '5px',
			display: 'none',
		})
		const rRow = this._createRowElements('<strong>Render</strong>')
		rRow.container.classList.add('system-row')
		rRow.container.title = 'Renderer.render'
		rRow.container.style.display = 'none' // Initially hidden
		this.rendererElements = { ...rRow, hr: rHr }

		// Summary Section
		const sHr = this._createStyledElement('hr', {
			borderColor: '#444',
			marginTop: '10px',
			marginBottom: '5px',
			display: 'none',
		})
		const sRow = this._createRowElements('Total', true)
		sRow.container.classList.add('system-row')
		sRow.container.title = 'Total Frame Time (Sum of Averages)'
		sRow.container.style.display = 'none' // Initially hidden
		this.summaryElements = { ...sRow, hr: sHr }

		// Memory Section
		const mHr = this._createStyledElement('hr', {
			borderColor: '#444',
			marginTop: '10px',
			marginBottom: '5px',
			display: 'none',
		})
		const mRow = this._createMemoryRowElements('Memory')
		mRow.container.style.display = 'none' // Initially hidden
		this.memoryElements = { ...mRow, hr: mHr }

		// --- Append in the new order ---
		this._createSystemsListContainer()
		this.panel.append(this.rendererElements.hr, this.rendererElements.container)
		this.panel.append(this.commandBufferElements.hr, this.commandBufferElements.container)
		this.panel.append(this.summaryElements.hr, this.summaryElements.container)
		this.panel.append(this.memoryElements.hr, this.memoryElements.container)

		document.body.appendChild(this.panel)
	}

	_createSystemsListContainer() {
		const systemsListContainer = document.createElement('div')

		// Use event delegation on the container for efficient event handling.
		systemsListContainer.addEventListener('click', event => {
			const row = event.target.closest('[data-system-name]')
			if (row) {
				const systemName = row.dataset.systemName
				if (this.pinnedSystems.has(systemName)) {
					this.pinnedSystems.delete(systemName)
				} else {
					this.pinnedSystems.add(systemName)
				}
				// Re-render immediately for responsiveness.
				if (this.lastProcessedStats) {
					this._renderSystemsList(this.lastProcessedStats)
				}
			}
		})

		const header = this._createStyledElement('div', {
			display: 'flex',
			justifyContent: 'space-between',
			gap: '10px',
			paddingBottom: '5px',
			fontWeight: 'bold',
			borderBottom: '1px solid #555',
			marginBottom: '5px',
		})

		const nameHeader = this._createStyledElement('span', { flex: 2, textAlign: 'left' }, 'System')
		const avgHeader = this._createStyledElement('span', { flex: 1, textAlign: 'right' }, 'Avg')
		const maxHeader = this._createStyledElement('span', { flex: 1, textAlign: 'right' }, 'Max')
		header.append(nameHeader, avgHeader, maxHeader)

		this.systemsListBody = document.createElement('div')

		this.pinnedSeparator = this._createStyledElement('hr', {
			borderColor: '#555',
			margin: '5px 0',
			borderStyle: 'dashed',
			display: 'none',
		})

		systemsListContainer.append(header, this.systemsListBody)
		this.panel.appendChild(systemsListContainer)
	}

	_createSystemRow() {
		const container = this._createStyledElement('div', {
			display: 'flex',
			justifyContent: 'space-between',
			alignItems: 'center',
			gap: '10px',
			cursor: 'pointer',
			padding: '1px 2px',
			borderRadius: '2px',
		})
		container.classList.add('system-row')

		const name = this._createStyledElement('span', {
			flex: 2,
			textAlign: 'left',
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
		})

		const avg = this._createStyledElement('span', { flex: 1, textAlign: 'right' })
		const max = this._createStyledElement('span', { flex: 1, textAlign: 'right' })

		container.append(name, avg, max)
		return { container, name, avg, max }
	}

	_createRowElements(labelText, isBold = false) {
		const container = this._createStyledElement('div', {
			display: 'flex',
			justifyContent: 'space-between',
			alignItems: 'center',
			gap: '10px',
			fontWeight: isBold ? 'bold' : 'normal',
		})

		const name = this._createStyledElement('span', { flex: 2, textAlign: 'left' })
		name.innerHTML = labelText // Use innerHTML to allow for <strong> tags

		const avg = this._createStyledElement('span', { flex: 1, textAlign: 'right' })
		const max = this._createStyledElement('span', { flex: 1, textAlign: 'right' })

		container.append(name, avg, max)
		return { container, name, avg, max }
	}

	_createMemoryRowElements(labelText) {
		const container = this._createStyledElement('div', {
			display: 'flex',
			justifyContent: 'space-between',
			alignItems: 'center',
			fontWeight: 'bold',
		})

		const name = this._createStyledElement('span', {})
		name.innerHTML = labelText

		const value = this._createStyledElement('span', {})

		container.append(name, value)
		return { container, name, value }
	}

	_createStyledElement(tag, styles, textContent = '') {
		const el = document.createElement(tag)
		Object.assign(el.style, styles)
		if (textContent) el.textContent = textContent
		return el
	}
}
