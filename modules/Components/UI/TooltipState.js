/**
 * A singleton component that holds the desired state for a tooltip.
 * UI interactions write to this component, and the TooltipSystem reads from it.
 */
export class TooltipState {
	static schema = {
		/** The entity that the tooltip should be displayed for. */
		targetEntityId: 'u32',
		/** The current visibility state of the tooltip. See TooltipState.STATE */
		state: {
			type: 'enum',
			of: 'u8',
			values: ['HIDDEN', 'SHOWN', 'LINGERING', 'FADING_OUT'],
		},
		/** A timestamp (performance.now()) used for timed state transitions (e.g., lingering, fading). */
		stateChangeTimestamp: 'f64',
		/** The screen X coordinate for the tooltip. */
		x: 'f64',
		/** The screen Y coordinate for the tooltip. */
		y: 'f64',
	}

	constructor({ targetEntityId = 0, state = 'HIDDEN', stateChangeTimestamp = 0, x = 0, y = 0 } = {}) {
		this.targetEntityId = targetEntityId
		this.state = state
		this.stateChangeTimestamp = stateChangeTimestamp
		this.x = x
		this.y = y
	}
}
