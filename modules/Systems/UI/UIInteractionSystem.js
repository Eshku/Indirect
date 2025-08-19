const { theManager } = await import(`${PATH_MANAGERS}/TheManager/TheManager.js`)

const { uiManager, queryManager, entityManager, componentManager } = theManager.getManagers()

const { TooltipState } = await theManager.getManager('ComponentManager').getComponents()

/**
 * A system that bridges raw UI input events with the ECS world.
 * It listens to events on UI elements (like the Hotbar) and translates them
 * into state changes on components (like TooltipState) via the CommandBuffer.
 */
export class UIInteractionSystem {
	constructor() {
		this.tooltipStateQuery = null
		this.tooltipStateTypeId = null
		this.tooltipControlEntityId = null // Cached ID

		// Cache the enum mapping for the state property to avoid lookups in the hot loop.
		const tooltipStateInfo = componentManager.componentInfo[componentManager.getComponentTypeID(TooltipState)]
		this.stateEnumIndexMap = tooltipStateInfo.representations.state.enumMap
		this.stateEnumValueMap = tooltipStateInfo.representations.state.valueMap

		this.hotbar = null
		this.hoveredSlotIndex = -1
	}

	async init() {
		// This query will find the singleton entity with the TooltipState.
		this.tooltipStateQuery = queryManager.getQuery({
			with: [TooltipState],
		})
		this.tooltipStateTypeId = componentManager.getComponentTypeID(TooltipState)

		this.hotbar = uiManager.getElement('Hotbar')

		this._setupHotbarEvents()
	}

	/**
	 * Finds and caches the singleton entity ID for the tooltip state.
	 * This is a robust way to get the entity without relying on init order or global registries.
	 * @returns {number|null} The entity ID, or null if not found.
	 * @private
	 */
	_getTooltipControlEntityId() {
		// If we have a cached ID, check if the entity is still active.
		if (this.tooltipControlEntityId !== null && entityManager.isEntityActive(this.tooltipControlEntityId)) {
			return this.tooltipControlEntityId
		}

		// If not, find it via the query. Since it's a singleton, we only need the first result.
		for (const chunk of this.tooltipStateQuery.iter()) {
			for (const entityIndex of chunk) {
				this.tooltipControlEntityId = chunk.archetype.entities[entityIndex]

				return this.tooltipControlEntityId
			}
		}

		// If we reach here, the entity hasn't been created yet or was destroyed.
		this.tooltipControlEntityId = null
		return null
	}

	/**
	 * Gets the current state value of the singleton tooltip entity.
	 * This is a fast, direct query for use in event handlers.
	 * @returns {string|null} The state value (e.g., 'SHOWN'), or null if not found.
	 * @private
	 */
	_getTooltipStateValue() {
		// This is a singleton query, so it's very fast.
		for (const chunk of this.tooltipStateQuery.iter()) {
			const stateArrays = chunk.archetype.componentArrays[this.tooltipStateTypeId]
			for (const entityIndex of chunk) {
				const stateIndex = stateArrays.state[entityIndex]
				return this.stateEnumValueMap[stateIndex]
			}
		}
		return null
	}

	_setupHotbarEvents() {
		this.hotbar.container.on('pointermove', event => {
			const tooltipEntityId = this._getTooltipControlEntityId()

			const pos = event.data.global
			const slotIndex = this.hotbar.getSlotIndexAt(pos)

			// We update the hovered slot index for internal tracking, but the logic below
			// only depends on the current slotIndex, making it stateless and robust.
			this.hoveredSlotIndex = slotIndex

			// Based on the current position, decide if a tooltip should be shown.
			if (slotIndex !== null && this.hotbar.slots[slotIndex].itemId !== null) {
				// We are over a valid item. Command to show/update the tooltip.
				// This is declarative: it sets the complete desired state every time,
				// preventing the tooltip from getting "stuck" in a hidden state.
				const slot = this.hotbar.slots[slotIndex]
				this.commands.setComponentData(tooltipEntityId, this.tooltipStateTypeId, {
					state: 'SHOWN', // This cancels any pending linger/fade
					targetEntityId: slot.itemId,
					x: pos.x,
					y: pos.y,
				})
			} else {
				// We are over an empty slot or no slot at all.
				// Only command a state change if the tooltip is currently fully shown.
				// This prevents starting a new linger/fade if one is already in progress or if the tooltip is hidden.
				const currentState = this._getTooltipStateValue()
				if (currentState === 'SHOWN') {
					this.commands.setComponentData(tooltipEntityId, this.tooltipStateTypeId, {
						state: 'LINGERING',
						stateChangeTimestamp: performance.now(),
					})
				}
			}
		})

		this.hotbar.container.on('pointerleave', () => {
			const tooltipEntityId = this._getTooltipControlEntityId()

			this.hoveredSlotIndex = -1
			const currentState = this._getTooltipStateValue()
			if (currentState === 'SHOWN') {
				this.commands.setComponentData(tooltipEntityId, this.tooltipStateTypeId, {
					state: 'LINGERING',
					stateChangeTimestamp: performance.now(),
				})
			}
		})
	}

	//no update method needed, event-driven system
}
