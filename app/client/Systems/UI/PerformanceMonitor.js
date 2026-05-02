const { engine } = await import(`@client/Engine.js`)
const { ecs } = engine.getManagers()
const { systemManager } = ecs

// --- Constants for Configuration ---
const PANEL_UPDATE_INTERVAL_S = 1 // Seconds
const STATS_WINDOW_DURATION_S = 3.0 // Calculate stats over the last 3 seconds.
const BREACHING_THRESHOLD_MS = 8.0 // Threshold for a single system time to be colored red.
const LIST_REFRESH_INTERVAL_S = 1.0 // How often to re-sort and select the top systems.
const FRAME_TIME_WARNING_THRESHOLD_MS = 15.0 // ms. Log a console warning if total frame time is breached.
const TOP_SYSTEMS_COUNT = 5 // How many of the slowest systems to show by default.

/**
 * A system that displays the execution time of other systems in a UI panel.
 * It reads timing data collected by the GameLoop and provides a stable, readable display
 * with average and max timings, filtering, and a clear layout.
 *
 * ---
 *
 * ### Developer Note: What is Measured?
 *
 * The performance monitor provides timings for the main thread only. It does **not** currently measure the
 * execution time of parallel kernel jobs that run on Web Workers.
 *
 * The detailed breakdown for a system is as follows:
 *
 * - **`Update`**: The execution time of the system's `update()` method. This is always a main-thread job.
 * - **`Schedule`**: The time it takes for the system's `schedule()` method to run and create its job definitions.
 *   This measures the cost of **job creation**, not job execution. This is always a main-thread operation.
 * - **`Process`**: The execution time of the system's `process()` method. This is always a main-thread job.
 * - **`Total`**: The sum of `Update`, `Schedule`, `Process`, and the execution time of any `KERNEL` jobs that
 *   happened to be executed by the main thread during its work-stealing loop.
 *
 * The `Render` and `Entity Command Buffer` timings are also main-thread-only operations.
 *
 * ---
 *
 * This monitor is designed to be a comprehensive, non-intrusive tool for debugging performance.
 *
 * - **Data Collection**: It pulls raw timing data from `SystemManager.systemTimings` each frame.
 * - **Sliding Window**: It calculates `avg` and `max` execution times over a configurable `windowDuration` (e.g., 1 second)
 *   to provide a rolling, stable view of performance rather than noisy, per-frame numbers.
 * - **Top Systems**: By default, it shows only the top 5 slowest systems (by max execution time) to provide a clean,
 *   stable view of the most expensive operations. This can be toggled with the "Show all" checkbox to display all systems.
 * - **Pinning**: You can click on any system in the list to "pin" it. Pinned systems are always displayed at the top
 *   of the list in a separate group, sorted alphabetically. This is extremely useful for tracking a specific system's
 *   behavior without it being lost in the main list, which is sorted by `max` time.
 */

//! workers are not measured currently
//! Measuring them would mean adding overhead per job
//! Somewhat efficient implementation would be to let workers write into their own buffers (no atomics)
//! Then sync on main thread.

export class PerformanceMonitor {
	constructor() {
		this.systemManager = null // Injected in init
		this.panel = null
		this.systemsListBody = null

		// --- DOM element references ---
		this.rendererElements = { container: null, name: null, avg: null, max: null, hr: null }
		this.commandBufferElements = { container: null, name: null, avg: null, max: null, hr: null }
		this.summaryElements = { container: null, name: null, avg: null, max: null, hr: null }
		this.systemRowElements = new Map()
		this.pinnedSeparator = null

		// --- State ---
		this.lastProcessedStats = null
		this.pinnedSystems = new Set() // Systems to always show at the top.
		this.expandedSystems = new Set() // Systems whose detailed view is open.
		this.topUnpinnedSystems = [] // Cache of system names to display in the unpinned list.

		// --- Timing & History ---
		this.timeAccumulator = 0
		this.listUpdateAccumulator = 0
		this.history = {}
		this.currentFrameSystems = [] // Pre-allocate for warnings
		this.loggableWarningSystems = [] // Pre-allocate for logging warnings
		this.untrackedSystems = new Set() // Systems to permanently ignore.
	}

	init() {
		this.systemManager = systemManager
		this._createPanel()

		// Pre-track all existing systems from the canonical list
		for (const systemName of this.systemManager._systemList) {
			this.trackSystem(systemName)
		}
		// Also pre-track special "pseudo-systems"
		this.trackSystem('Render')
		this.trackSystem('Entity Command Buffer')
		this.trackSystem('Total Frame Time')

		window.performanceMonitor = this
	}

	resetSystem(systemName) {
		if (this.history[systemName]) {
			// Clear the history for the system to ensure fresh stats after HMR.
			this.history[systemName].length = 0
		}
		// Pinned and expanded states are preserved as they are keyed by name, which is desirable.
		// The UI row will be updated on the next display update. If history is empty, it will temporarily disappear.
	}

	trackSystem(systemName) {
		if (!this.history[systemName]) {
			this.history[systemName] = []
		}
	}

	/**
	 * This method is called by the GameLoop *after* all other system jobs are complete.
	 */
	updateTimings(deltaTime) {
		this.listUpdateAccumulator += deltaTime
		const now = performance.now()

		// --- New logic for frame time warning ---
		this.currentFrameSystems.length = 0 // Clear without re-allocating
		let currentFrameTotalTime = 0


		for (const key in this.systemManager.systemTimings) {
			let systemName
			const numericKey = Number(key)
			if (Number.isNaN(numericKey)) {
				systemName = key // 'Render', 'Entity Command Buffer'
			} else {
				systemName = this.systemManager.getSystemNameById(numericKey)
			}

			// NEW: Add a guard to handle cases where a system ID might not resolve to a name.
			if (!systemName) {
				// This indicates a potential issue in the SystemManager's ID mapping.
				// We'll log a warning but continue, to prevent the monitor from crashing the app.
				console.warn(`PerformanceMonitor: Could not resolve system name for ID ${numericKey}. Skipping timing.`)
				continue
			}

			// If the system has been explicitly untracked, ignore its timings.
			if (this.untrackedSystems.has(systemName)) {
				continue
			}

			// Ensure the history array exists before pushing to it.
			// This handles systems that might be added dynamically or not present during init.
			if (!this.history[systemName]) {
				this.trackSystem(systemName)
			}

			const timingData = this.systemManager.systemTimings[key]

			// --- Accumulate for frame time warning ---
			currentFrameTotalTime += timingData.total
			// This still allocates a small object, but that's unavoidable if we want to sort.
			this.currentFrameSystems.push({ name: systemName, time: timingData.total })

			// Store the full timing object in history
			this.history[systemName].push({ time: timingData.total, details: timingData, timestamp: now })
		}

		// --- Check and log frame time warning ---
		if (currentFrameTotalTime >= FRAME_TIME_WARNING_THRESHOLD_MS) {
			this.currentFrameSystems.sort((a, b) => b.time - a.time)

/* 			console.warn(
				`%cPerformance Warning:%c Frame time breached ${FRAME_TIME_WARNING_THRESHOLD_MS.toFixed(
					1,
				)}ms threshold. Total: ${currentFrameTotalTime.toFixed(3)}ms. Top 5 systems:`,
				'color: #e67e22; font-weight: bold;',
				'color: white;',
			) */

			this.loggableWarningSystems.length = 0
			const count = Math.min(this.currentFrameSystems.length, TOP_SYSTEMS_COUNT)
			for (let i = 0; i < count; i++) {
				const s = this.currentFrameSystems[i]
				this.loggableWarningSystems.push({ System: s.name, 'Time (ms)': s.time.toFixed(3) })
			}
			//console.table(this.loggableWarningSystems)
		}

		this.history['Total Frame Time'].push({ time: currentFrameTotalTime, details: {}, timestamp: now })
	}

	/**
	 * This method is called by the GameLoop *after* all jobs and entity command buffer have finished.
	 * It processes the accumulated history and updates the DOM.
	 * @param {number} deltaTime - The frame's delta time.
	 */
	updateDisplay(deltaTime) {
		// 2. Check if it's time to update the display.
		this.timeAccumulator += deltaTime
		if (this.timeAccumulator < PANEL_UPDATE_INTERVAL_S) return

		// 3. Process history and render all panels
		this._processAndUpdate() // This now uses the new 'Total Frame Time' metric

		// 4. Reset for the next interval.
		this.timeAccumulator -= PANEL_UPDATE_INTERVAL_S
	}

	/**
	 * Injects a <style> block into the document head for the monitor's CSS. This keeps the component
	 * self-contained.
	 * @private
	 */
	_injectStyles() {
		const styleId = 'performance-monitor-styles'
		if (document.getElementById(styleId)) return

		const style = document.createElement('style')
		style.id = styleId
		style.innerHTML = `
            #performance-monitor .system-row.pinned { background-color: rgba(255, 255, 100, 0.1); }
            #performance-monitor .system-row.breaching { color: #ff6b6b; }
            #performance-monitor .detail-row { display: none; background-color: rgba(255, 255, 255, 0.05); padding-left: 20px; font-style: italic; }
        `
		document.head.appendChild(style)
	}

	/**
	 * Public API to programmatically pin a system for tracking.
	 * Pinned systems are always visible at the top of the monitor.
	 * @param {...string} systemNames - The name(s) of the system(s) to pin.
	 */
	pin(...systemNames) {
		if (systemNames.length === 0) {
			console.warn('PerformanceMonitor.pin: Please provide at least one system name.')
			return false
		}

		let changed = false
		for (const systemName of systemNames) {
			if (typeof systemName !== 'string' || !systemName) {
				console.warn(`PerformanceMonitor.pin: Invalid system name provided: ${systemName}. Skipping.`)
				continue
			}
			// Only flag a change if the system wasn't already pinned.
			if (!this.pinnedSystems.has(systemName)) {
				this.pinnedSystems.add(systemName)
				changed = true
			}
		}

		// Always re-render for simplicity, as this is a debug console API.
		if (this.lastProcessedStats) this._renderSystemsList(this.lastProcessedStats)
		return changed
	}

	/**
	 * Public API to programmatically un-pin a system.
	 * @param {string} systemName - The name of the system to unpin.
	 * @param {...string} systemNames - The name(s) of the system(s) to unpin.
	 */
	unpin(...systemNames) {
		if (systemNames.length === 0) {
			console.warn('PerformanceMonitor.unpin: Please provide at least one system name.')
			return false
		}

		let changed = false
		for (const systemName of systemNames) {
			if (typeof systemName !== 'string' || !systemName) {
				console.warn(`PerformanceMonitor.unpin: Invalid system name provided: ${systemName}. Skipping.`)
				continue
			}
			// .delete() returns true if an element was successfully removed.
			if (this.pinnedSystems.delete(systemName)) {
				changed = true
			}
		}

		// Always re-render for simplicity.
		if (this.lastProcessedStats) this._renderSystemsList(this.lastProcessedStats)
		return changed
	}

	/**
	 * Public API to un-pin all currently tracked systems.
	 */
	unpinAll() {
		if (this.pinnedSystems.size === 0) {
			return false
		}

		const changed = this.pinnedSystems.size > 0
		this.pinnedSystems.clear()
		if (this.lastProcessedStats) this._renderSystemsList(this.lastProcessedStats)
		return changed
	}

	/**
	 * Public API to completely stop tracking a system.
	 * This removes it from the history and the UI.
	 * @param {string} systemName - The name of the system to untrack.
	 */
	untrack(systemName) {
		if (typeof systemName !== 'string' || !systemName) {
			console.warn('PerformanceMonitor.untrack: Please provide a valid system name.')
			return
		}

		if (!this.history[systemName]) {
			console.log(`PerformanceMonitor: System "${systemName}" is not being tracked.`)
			return
		}

		// Add to the blacklist so it's not re-added on the next frame.
		this.untrackedSystems.add(systemName)

		// If the system is re-tracked later, we'll need to remove it from here.
		// For now, this ensures it stays gone.

		delete this.history[systemName]
		this.pinnedSystems.delete(systemName)

		const row = this.systemRowElements.get(systemName)
		if (row) {
			row.container.remove()
			this.systemRowElements.delete(systemName)
		}

		console.log(`PerformanceMonitor: Stopped tracking "${systemName}".`)
	}

	/**
	 * Public API to stop tracking all systems that are not currently pinned.
	 */
	untrackNotPinned() {
		const systemsToUntrack = Object.keys(this.history).filter(
			name => !this.pinnedSystems.has(name) && name !== 'Render' && name !== 'Entity Command Buffer',
		)

		if (systemsToUntrack.length === 0) {
			console.log('PerformanceMonitor: No unpinned systems to untrack.')
			return
		}

		for (const name of systemsToUntrack) {
			this.untrack(name)
		}
		this._processAndUpdate()
	}

	/**
	 * Returns a sorted list of all system names currently being tracked.
	 * This is useful for discovering system names to use with .pin().
	 * @returns {string[]} A sorted array of system names.
	 */
	getSystemNames() {
		return Object.keys(this.history).sort()
	}

	_processAndUpdate() {
		const { rendererStats, commandBufferStats, otherSystemsStats, totalFrameTimeStats } = this._calculateCurrentStats()

		// Cache the stats needed for immediate re-rendering on UI interaction (pinning, toggling).
		this.lastProcessedStats = otherSystemsStats

		// Render all sections with the new data.
		this._renderSystemsList(otherSystemsStats)
		this._renderSpecialRow(rendererStats, this.rendererElements, 'Render', false)
		this._renderSpecialRow(commandBufferStats, this.commandBufferElements, 'Entity Command Buffer', false)
		this._renderSummary(totalFrameTimeStats)
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
			let totalTime = 0
			let maxTime = 0
			let totalUpdate = 0,
				totalSchedule = 0,
				totalProcess = 0,
				maxUpdate = 0,
				maxSchedule = 0,
				maxProcess = 0

			for (const record of systemHistory) {
				totalTime += record.time
				if (record.time > maxTime) {
					maxTime = record.time
				}
				if (typeof record.details === 'object') {
					const { update = 0, schedule = 0, process = 0 } = record.details
					totalUpdate += update
					totalSchedule += schedule
					totalProcess += process

					if (update > maxUpdate) maxUpdate = update
					if (schedule > maxSchedule) maxSchedule = schedule
					if (process > maxProcess) maxProcess = process
				}
			}
			const avgTime = totalTime / systemHistory.length
			const avgUpdate = totalUpdate / systemHistory.length
			const avgSchedule = totalSchedule / systemHistory.length
			const avgProcess = totalProcess / systemHistory.length

			processedStats[systemName] = {
				avg: avgTime,
				max: maxTime,
				count: systemHistory.length,
				details: {
					update: { avg: avgUpdate, max: maxUpdate },
					schedule: { avg: avgSchedule, max: maxSchedule },
					process: { avg: avgProcess, max: maxProcess },
				},
			}
		}

		const rendererStats = processedStats['Render']
		const commandBufferStats = processedStats['Entity Command Buffer']
		const totalFrameTimeStats = processedStats['Total Frame Time']

		const otherSystemsStats = { ...processedStats }
		delete otherSystemsStats['Render']
		delete otherSystemsStats['Entity Command Buffer']
		delete otherSystemsStats['Total Frame Time']

		return { rendererStats, commandBufferStats, otherSystemsStats, totalFrameTimeStats }
	}

	/**
	 * Generic renderer for special, always-visible rows like CommandBuffer and Renderer.
	 * @param {object} data - The stats object for the row.
	 * @param {object} elements - The DOM elements for the row.
	 * @param {string} systemName - The internal name and display name of the system.
	 * @private
	 */
	_renderSpecialRow(data, elements, systemName, isSingleValue = false) {
		const { container, avg, max, hr } = elements
		if (!container) return

		if (!data || data.count === 0) {
			container.style.display = 'none'
			if (hr) hr.style.display = 'none'
			return
		}

		container.style.display = 'flex'
		if (hr) hr.style.display = 'block'

		// For single-value rows like Render, the 'avg' and 'max' are the same.
		const breachValue = isSingleValue ? data.avg : data.max

		const isBreaching = breachValue >= BREACHING_THRESHOLD_MS

		container.classList.toggle('breaching', isBreaching)
		if (isSingleValue) {
			avg.textContent = data.avg.toFixed(3)
			max.textContent = '-' // No separate max for single-value items
		} else {
			avg.textContent = data.avg.toFixed(3)
			max.textContent = data.max.toFixed(3)
		}
	}

	_updateSystemRow(rowElements, system) {
		const { name, avg, max, details } = system
		const { container, name: nameEl, avg: avgEl, max: maxEl, detailRows } = rowElements

		const isBreaching = max >= BREACHING_THRESHOLD_MS
		const isPinned = this.pinnedSystems.has(name)
		const isExpanded = this.expandedSystems.has(name)

		container.dataset.systemName = name
		container.title = `${name} (L-Click to expand, R-Click to ${isPinned ? 'unpin' : 'pin'})`
		container.classList.toggle('pinned', isPinned)
		container.classList.toggle('breaching', isBreaching)

		nameEl.textContent = name
		avgEl.textContent = avg.toFixed(3)
		maxEl.textContent = max.toFixed(3)

		// Update and show/hide detail rows
		this._updateDetailRow(detailRows.update, 'Update', details.update, isExpanded)
		this._updateDetailRow(detailRows.schedule, 'Schedule', details.schedule, isExpanded)
		this._updateDetailRow(detailRows.process, 'Process', details.process, isExpanded)
	}

	_updateDetailRow(detailRow, label, value, isExpanded) {
		// value is now an object { avg, max }
		if (value.avg > 0 && isExpanded) {
			detailRow.container.style.display = 'flex'
			detailRow.avg.textContent = value.avg.toFixed(3)
			detailRow.max.textContent = value.max.toFixed(3)
		} else {
			detailRow.container.style.display = 'none'
		}
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
		const allSystems = Object.entries(systemsStats).map(([name, data]) => ({
			name,
			avg: data.avg,
			max: data.max,
			details: data.details,
		}))

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
					// If a system from our cached top list has no stats this frame (e.g., it stopped running), create a dummy object
					// so it still gets rendered, preventing the list from shrinking and causing "missed clicks".
					return (
						stats || {
							name,
							avg: 0,
							max: 0,
							details: {
								update: { avg: 0, max: 0 },
								schedule: { avg: 0, max: 0 },
							},
							process: { avg: 0, max: 0 },
						}
					)
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
				row.detailRows.update.container.remove()
				row.detailRows.schedule.container.remove()
				row.detailRows.process.container.remove()
				this.systemRowElements.delete(name)
			}
		}

		const body = this.systemsListBody
		const desiredNodes = []
		const addSystemNodes = system => {
			const row = this.systemRowElements.get(system.name)
			desiredNodes.push(
				row.container,
				row.detailRows.update.container,
				row.detailRows.schedule.container,
				row.detailRows.process.container,
			)
		}

		// Add main rows and their detail rows to the desired order
		pinned.forEach(addSystemNodes)

		if (pinned.length > 0 && unpinnedToDisplay.length > 0) {
			this.pinnedSeparator.style.display = 'block'
			desiredNodes.push(this.pinnedSeparator)
		} else {
			this.pinnedSeparator.style.display = 'none'
		}
		unpinnedToDisplay.forEach(addSystemNodes)

		// Reconcile the current DOM order with the desired order.
		let currentElement = body.firstChild
		desiredNodes.forEach(node => {
			if (currentElement === node) {
				currentElement = currentElement.nextSibling
			} else {
				body.insertBefore(node, currentElement)
			}
		})

		// Any remaining elements in the body are old and should be removed.
		while (currentElement) {
			const next = currentElement.nextSibling
			body.removeChild(currentElement)
			currentElement = next
		}
	}

	_renderSummary(totalFrameTimeStats) {
		const { container, avg, max, hr } = this.summaryElements
		if (!container) return

		if (!totalFrameTimeStats || totalFrameTimeStats.count === 0) {
			container.style.display = 'none'
			hr.style.display = 'none'
			return
		}

		// The total average time is a good indicator of overall frame cost. If this breaches our threshold, it's a
		// significant performance issue.
		const isBreaching = totalFrameTimeStats.max >= FRAME_TIME_WARNING_THRESHOLD_MS

		container.style.display = 'flex'
		hr.style.display = 'block'

		container.classList.toggle('breaching', isBreaching)
		avg.textContent = totalFrameTimeStats.avg.toFixed(3)
		max.textContent = totalFrameTimeStats.max.toFixed(3)
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
				'Performance Monitor',
			),
		)

		// Renderer Section
		const rHr = this._createStyledElement('hr', {
			borderColor: '#444',
			marginTop: '10px',
			marginBottom: '5px',
			display: 'none',
		})
		const rRow = this._createRowElements('<strong>Render</strong>')
		rRow.container.classList.add('system-row')
		rRow.container.title = 'Render'
		rRow.container.style.display = 'none' // Initially hidden
		this.rendererElements = { ...rRow, hr: rHr }

		// Command Buffer Section
		const cbHr = this._createStyledElement('hr', {
			borderColor: '#444',
			marginTop: '10px',
			marginBottom: '5px',
			display: 'none',
		})
		const cbRow = this._createRowElements('<strong>Entity Command Buffer</strong>')
		cbRow.container.classList.add('system-row')
		cbRow.container.title = 'Entity Command Buffer'
		cbRow.container.style.display = 'none' // Initially hidden
		this.commandBufferElements = { ...cbRow, hr: cbHr }

		// Summary Section
		const sHr = this._createStyledElement('hr', {
			borderColor: '#444',
			marginTop: '10px',
			marginBottom: '5px',
			display: 'none',
		})
		const sRow = this._createRowElements('<strong>Total</strong>', true)
		sRow.container.classList.add('system-row')
		sRow.container.title = 'Total Frame Time (Sum of Averages)'
		sRow.container.style.display = 'none' // Initially hidden
		this.summaryElements = { ...sRow, hr: sHr }

		// --- Append in the new order ---
		this._createSystemsListContainer()
		this.panel.append(this.rendererElements.hr, this.rendererElements.container)
		this.panel.append(this.commandBufferElements.hr, this.commandBufferElements.container)
		this.panel.append(this.summaryElements.hr, this.summaryElements.container)

		document.body.appendChild(this.panel)
	}

	_createSystemsListContainer() {
		const systemsListContainer = document.createElement('div')

		// Use event delegation on the container for efficient event handling.
		systemsListContainer.addEventListener('click', event => {
			event.preventDefault()
			const row = event.target.closest('[data-system-name]')
			if (row) {
				const systemName = row.dataset.systemName
				if (this.expandedSystems.has(systemName)) {
					this.expandedSystems.delete(systemName)
				} else {
					this.expandedSystems.add(systemName)
				}
				// Re-render immediately for responsiveness.
				if (this.lastProcessedStats) {
					this._renderSystemsList(this.lastProcessedStats)
				}
			}
		})
		systemsListContainer.addEventListener('contextmenu', event => {
			event.preventDefault()
			const row = event.target.closest('[data-system-name]')
			if (row) {
				const systemName = row.dataset.systemName
				if (this.pinnedSystems.has(systemName)) {
					this.unpin(systemName)
				} else {
					this.pin(systemName)
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

		const detailRows = {
			update: this._createDetailRowElements('Update'),
			schedule: this._createDetailRowElements('Schedule'),
			process: this._createDetailRowElements('Process'),
		}

		return { container, name, avg, max, detailRows }
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

	_createDetailRowElements(labelText) {
		const container = this._createStyledElement('div', {
			display: 'none', // Initially hidden
			justifyContent: 'space-between',
			alignItems: 'center',
			gap: '10px',
			padding: '1px 2px 1px 20px', // Indent
			fontStyle: 'italic',
			color: '#ccc',
		})
		container.classList.add('detail-row')

		const name = this._createStyledElement('span', { flex: 2, textAlign: 'left' })
		name.innerHTML = labelText

		const avg = this._createStyledElement('span', { flex: 1, textAlign: 'right' })
		const max = this._createStyledElement('span', { flex: 1, textAlign: 'right' })

		container.append(name, avg, max)
		return { container, name, avg, max }
	}

	_createStyledElement(tag, styles, textContent = '') {
		const el = document.createElement(tag)
		Object.assign(el.style, styles)
		if (textContent) el.textContent = textContent
		return el
	}

	destroy() {
		const styleId = 'performance-monitor-styles'
		const styleElement = document.getElementById(styleId)
		if (styleElement) {
			styleElement.remove()
		}

		window.performanceMonitor = null

		this.panel?.remove()
		this.panel = null

		// Clear all state and references
		this.rendererElements = null
		this.commandBufferElements = null
		this.summaryElements = null
		this.systemRowElements?.clear()
		this.systemRowElements = null // Allow for garbage collection
		this.pinnedSeparator = null
		this.pinnedSystems.clear()
		this.expandedSystems.clear()
		this.history = {}
		this.untrackedSystems.clear()
	}
}
