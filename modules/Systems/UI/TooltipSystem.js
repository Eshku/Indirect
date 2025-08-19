const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)
const { uiManager, queryManager, entityManager, componentManager, prefabManager } = theManager.getManagers()

const { TooltipState, PrefabId, Parent } = await theManager.getManager('ComponentManager').getComponents()

const { Easing } = await import(`${PATH_CORE}/utils/easing.js`)
const { lerp } = await import(`${PATH_CORE}/utils/lerp.js`)

const { TooltipResolutionService } = await import(`${PATH_SERVICES}/TooltipResolutionService.js`)

const { LRUCache } = await import(`${PATH_CORE}/DataStructures/LRUCache.js`)

const LINGER_DURATION_MS = 200 // How long to wait before starting the fade.
const FADE_OUT_DURATION_MS = 500 // The duration of the fade-out animation.
const LERP_SPEED = 25 // Speed of the tooltip movement interpolation. Higher is faster.

/**
 * A data-driven system that manages the lifecycle of UI tooltips.
 * It reactively monitors a singleton TooltipState component for changes
 * and updates the UI accordingly. This replaces the event-driven TooltipService.
 */
export class TooltipSystem {
	constructor() {
		this.tooltipStateTypeId = componentManager.getComponentTypeID(TooltipState)

		// This query will react to any changes on the TooltipState component.
		this.reactiveQuery = queryManager.getQuery({
			with: [TooltipState],
			react: [TooltipState],
		})

		// Query for all entities with a PrefabId to build a cache for fast lookups.
		this.prefabIdQuery = queryManager.getQuery({ with: [PrefabId] })
		this.prefabIdTypeID = componentManager.getComponentTypeID(PrefabId)
		this.stringInterningTable = componentManager.stringInterningTable

		// This non-reactive query runs every frame to check timers.
		this.stateQuery = queryManager.getQuery({
			with: [TooltipState],
		})

		// Cache the enum mapping for the state property to avoid lookups in the hot loop.
		const tooltipStateInfo = componentManager.componentInfo[this.tooltipStateTypeId]
		this.stateEnumValueMap = tooltipStateInfo.representations.state.valueMap

		// The system now owns the resolution logic and view model caching.
		this.resolutionService = new TooltipResolutionService()
		// A cache for built view models to avoid rebuilding them on every hover. A size of
		// 50 is likely sufficient for all items a player might hover over in a session.
		this.viewModelCache = new LRUCache(50)

		// Create the singleton entity that holds the global tooltip state.
		// This is done at init time, so using the entity manager directly is acceptable.
		this.tooltipControlEntityId = entityManager.createEntityWithComponents(
			new Map([[TooltipState, { state: 'HIDDEN', targetEntityId: 0, x: 0, y: 0, stateChangeTimestamp: 0 }]])
		)

		// To prevent re-showing the same tooltip if only the position changes.
		this.lastShownTargetId = null
		this.activeTooltipView = null
		this._prefabIdCache = new Map() // entityId -> { offset, length }
		// For smooth movement
		this.currentPosition = { x: 0, y: 0 }
		this.targetPosition = { x: 0, y: 0 }
	}

	async init() {}

	update(deltaTime) {
		// --- Phase 1: Cache all prefab IDs for fast lookups later ---
		// This avoids expensive `entityManager.getComponent` calls inside other loops.
		this._prefabIdCache.clear()
		for (const chunk of this.prefabIdQuery.iter()) {
			const archetype = chunk.archetype
			const prefabIdArrays = archetype.componentArrays[this.prefabIdTypeID]
			const offsets = prefabIdArrays.id_offset
			const lengths = prefabIdArrays.id_length
			for (const entityIndex of chunk) {
				const entityId = archetype.entities[entityIndex]
				this._prefabIdCache.set(entityId, { offset: offsets[entityIndex], length: lengths[entityIndex] })
			}
		}

		// The reactive query's broad-phase culling ensures this loop is very cheap
		// and often skipped entirely if the TooltipState hasn't been modified.
		for (const chunk of this.reactiveQuery.iter()) {
			const stateArrays = chunk.archetype.componentArrays[this.tooltipStateTypeId]
			for (const entityIndex of chunk) {
				// The fine-grained check ensures we only process actual changes.
				if (this.reactiveQuery.hasChanged(chunk.archetype, entityIndex)) {
					this.processStateChange(stateArrays, entityIndex)
				}
			}
		}

		// --- Per-frame timer and movement part ---
		// This is a singleton, so we only need to process the first entity found.
		for (const chunk of this.stateQuery.iter()) {
			const stateArrays = chunk.archetype.componentArrays[this.tooltipStateTypeId]
			for (const entityIndex of chunk) {
				// Access raw data directly from the SoA arrays instead of creating a view object with .get().
				// This is a micro-optimization that reduces object churn in a hot loop.
				const stateIndex = stateArrays.state[entityIndex]
				const currentState = this.stateEnumValueMap[stateIndex]
				const now = performance.now()

				// --- Handle state transitions (Linger, Fade) ---
				if (currentState === 'LINGERING') {
					const lingerDuration = LINGER_DURATION_MS
					const stateChangeTimestamp = stateArrays.stateChangeTimestamp[entityIndex]
					const elapsed = now - stateChangeTimestamp
					if (elapsed >= lingerDuration) {
						// Linger time is up. Transition to FADING_OUT.
						this.commands.setComponentData(this.tooltipControlEntityId, this.tooltipStateTypeId, {
							state: 'FADING_OUT',
							stateChangeTimestamp: now,
						})
					}
				} else if (currentState === 'FADING_OUT') {
					const fadeDuration = FADE_OUT_DURATION_MS
					const stateChangeTimestamp = stateArrays.stateChangeTimestamp[entityIndex]
					const elapsed = now - stateChangeTimestamp
					const linearProgress = Math.min(1, elapsed / fadeDuration)
					const easedProgress = Easing.easeOutCubic(linearProgress)

					if (this.activeTooltipView) {
						this.activeTooltipView.setAlpha(1 - easedProgress)
					}

					if (linearProgress >= 1) {
						// Fade is complete. Command the state to be HIDDEN.
						this.commands.setComponentData(this.tooltipControlEntityId, this.tooltipStateTypeId, { state: 'HIDDEN' })
					}
				}

				// --- Handle smooth movement ---
				if (this.activeTooltipView) {
					const lerpSpeed = LERP_SPEED
					const dx = this.targetPosition.x - this.currentPosition.x
					const dy = this.targetPosition.y - this.currentPosition.y

					// If close enough, snap to the target to avoid jittering and stop processing.
					if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
						this.currentPosition.x = this.targetPosition.x
						this.currentPosition.y = this.targetPosition.y
					} else {
						// Interpolate the current position towards the target.
						// This formula provides frame-rate independent exponential smoothing.
						const lerpFactor = 1 - Math.exp(-lerpSpeed * deltaTime)
						this.currentPosition.x = lerp(this.currentPosition.x, this.targetPosition.x, lerpFactor)
						this.currentPosition.y = lerp(this.currentPosition.y, this.targetPosition.y, lerpFactor)
					}

					this.activeTooltipView.setPosition(this.currentPosition.x, this.currentPosition.y)
				}
				// Since it's a singleton, we can break after processing the first one.
				return
			}
		}
	}

	processStateChange(stateArrays, entityIndex) {
		const stateIndex = stateArrays.state[entityIndex]
		const desiredState = this.stateEnumValueMap[stateIndex]

		if (desiredState === 'SHOWN') {
			// Always update the target position for the lerp loop.
			this.targetPosition.x = stateArrays.x[entityIndex]
			this.targetPosition.y = stateArrays.y[entityIndex]

			// A 'SHOWN' command always makes the tooltip fully visible and stops any pending hide/fade.
			if (this.activeTooltipView) {
				// A tooltip is already active.
				this.activeTooltipView.setAlpha(1)

				const targetEntityId = stateArrays.targetEntityId[entityIndex]
				// If the target entity has changed, we need to build a new view model.
				if (this.lastShownTargetId !== targetEntityId) {
					const viewModel = this._buildViewModel(targetEntityId)
					if (viewModel) {
						this.activeTooltipView.update(viewModel)
						this.lastShownTargetId = targetEntityId
					} else {
						this.hideTooltip() // New target is invalid, hide.
					}
				}
			} else {
				// No tooltip is active, so show a new one. Snap its position to avoid sliding in.
				this.currentPosition.x = stateArrays.x[entityIndex]
				this.currentPosition.y = stateArrays.y[entityIndex]
				this.targetPosition.x = stateArrays.x[entityIndex] // Also snap the target to prevent lerping from 0,0
				this.showTooltip(stateArrays.targetEntityId[entityIndex], this.currentPosition)
			}
		} else if (desiredState === 'HIDDEN') {
			// An explicit command to hide instantly.
			this.hideTooltip()
		}
	}

	showTooltip(entityId, position) {
		if (!entityId || !entityManager.isEntityActive(entityId)) return

		const viewModel = this._buildViewModel(entityId)
		if (!viewModel) return

		const prefabLocation = this._prefabIdCache.get(entityId)
		if (!prefabLocation) {
			return
		}
		const prefabId = this.stringInterningTable.get(prefabLocation.offset, prefabLocation.length)

		const prefabData = prefabManager.getPrefabDataSync(prefabId)

		if (!prefabData) {
			console.warn(`TooltipSystem: Prefab data not found for prefab ID "${prefabId}" on entity ${entityId}.`)
			return
		}

		if (!prefabData.components || !prefabData.components.tooltip || !prefabData.components.tooltip.type) {
			console.warn(
				`TooltipSystem: Prefab "${prefabId}" (entity ${entityId}) is missing a valid tooltip configuration in its components (e.g., 'components.tooltip.type').`
			)
			return
		}
		const tooltipType = prefabData.components.tooltip.type

		const tooltipView = uiManager.getElement(tooltipType)

		if (!tooltipView)
			return console.error(
				`TooltipSystem: Tooltip view "${tooltipType}" specified in prefab "${prefabId}" is not registered with the UIManager.`
			)

		tooltipView.setAlpha(1.0) // Ensure alpha is reset when showing a new tooltip
		tooltipView.update(viewModel)
		tooltipView.setPosition(position.x, position.y)
		tooltipView.show()

		this.activeTooltipView = tooltipView
		this.lastShownTargetId = entityId
	}

	hideTooltip() {
		if (this.activeTooltipView) {
			this.activeTooltipView.hide()
			this.activeTooltipView = null
			this.lastShownTargetId = null
			// When hiding, reset positions to prevent the next tooltip from animating from the last spot.
			this.currentPosition.x = 0
			this.currentPosition.y = 0
			this.targetPosition.x = 0
			this.targetPosition.y = 0
		}
	}

	/**
	 * Builds a complete view model for a given item entity.
	 * This method orchestrates fetching the tooltip template from the prefab and resolving
	 * all dynamic values using the TooltipResolutionService.
	 * @param {number} itemEntityId - The entity ID of the item.
	 * @returns {object|null} The constructed view model, or null if one cannot be built.
	 * @private
	 */
	_buildViewModel(itemEntityId) {
		// Check the cache first for a significant performance boost.
		const cachedViewModel = this.viewModelCache.get(itemEntityId)
		if (cachedViewModel) {
			return cachedViewModel
		}

		if (!entityManager.isEntityActive(itemEntityId)) return null

		const itemPrefabIdComp = entityManager.getComponent(itemEntityId, PrefabId)
		if (!itemPrefabIdComp) return null

		const prefabId = itemPrefabIdComp.id.toString()
		const itemPrefabData = prefabManager.getPrefabDataSync(prefabId)
		if (!itemPrefabData?.components?.tooltip) {
			// This can happen if a prefab is not preloaded or doesn't have a tooltip.
			return null
		}

		// Pre-process the prefab's children into a flat map for fast, O(1) lookups by key.
		const childNodeMap = this.resolutionService.getOrBuildChildNodeMap(prefabId, itemPrefabData.children)

		const { tooltip: tooltipData, displayName: displayNameComp } = itemPrefabData.components
		const parentComp = entityManager.getComponent(itemEntityId, Parent)
		const ownerId = parentComp ? parentComp.entityId : null
		const ownerStats = this.resolutionService.getOwnerStats(ownerId)

		if (!displayNameComp) {
			console.warn(`TooltipSystem: Prefab '${prefabId}' is missing a 'displayName' component.`)
		}

		const viewModel = {
			title: displayNameComp ? displayNameComp.value.toString() : 'Unknown Item',
			description: [],
			stats: [],
		}

		const resolutionContext = {
			itemPrefabData,
			childNodeMap,
			ownerStats,
			itemDisplayName: viewModel.title,
		}

		this._buildDescription(viewModel, tooltipData.description, resolutionContext)
		this._buildStats(viewModel, tooltipData.stats, resolutionContext)
		this._buildFormulas(viewModel, tooltipData.formulas, resolutionContext)

		// Store the newly built view model in the cache for next time.
		this.viewModelCache.set(itemEntityId, viewModel)

		return viewModel
	}

	_buildDescription(viewModel, descriptionData, context) {
		if (!descriptionData) return

		if (typeof descriptionData === 'string') {
			viewModel.description.push({ type: 'text', value: descriptionData })
			return
		}

		if (typeof descriptionData === 'object' && descriptionData.template) {
			const { template, values } = descriptionData
			const resolvedValues = {}
			for (const key in values) {
				const descriptor = values[key]
				const resolved = this.resolutionService.resolveValue(descriptor, context)
				resolvedValues[key] = resolved.value
			}

			const descriptionParts = []
			let lastIndex = 0
			const regex = /\{(\w+)\}/g
			let match

			while ((match = regex.exec(template)) !== null) {
				if (match.index > lastIndex) {
					descriptionParts.push({ type: 'text', value: template.substring(lastIndex, match.index) })
				}

				const key = match[1]
				const value = resolvedValues[key] ?? '???'
				descriptionParts.push({ type: 'dynamic', value: String(value) })

				lastIndex = regex.lastIndex
			}

			if (lastIndex < template.length) {
				descriptionParts.push({ type: 'text', value: template.substring(lastIndex) })
			}
			viewModel.description = descriptionParts
		}
	}

	_buildStats(viewModel, statsData, context) {
		if (!statsData) return

		for (const statLine of statsData || []) {
			const valueDescriptor = statLine.value

			const resolvedValue =
				typeof valueDescriptor === 'string'
					? { value: valueDescriptor }
					: this.resolutionService.resolveValue(valueDescriptor, context)

			let valuePart = resolvedValue.value
			if (statLine.suffix) {
				const numericValue = Number(resolvedValue.value)
				if (!isNaN(numericValue)) {
					valuePart = numericValue.toFixed(2) + statLine.suffix
				} else {
					valuePart += statLine.suffix
				}
			}

			viewModel.stats.push({
				label: statLine.label,
				value: valuePart,
			})
		}
	}

	_buildFormulas(viewModel, formulasData, context) {
		if (!formulasData) return

		viewModel.formulas = []

		for (const formulaLine of formulasData) {
			const resolvedValue = this.resolutionService.resolveValue(formulaLine.value, context)
			// Only add the formula to the view model if the resolution service returned a non-empty string.
			if (resolvedValue?.value) {
				viewModel.formulas.push({
					label: formulaLine.label,
					value: resolvedValue.value,
				})
			}
		}
	}
}
