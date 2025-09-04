/**
 * A component that holds the static data needed to construct a tooltip.
 */
export class Tooltip {
	static schema = {
		type: 'string',
		description: 'string',
		stats: {
			type: 'flat_array',
			of: 'string',
			capacity: 10,
		},
	}

	constructor({ type = 'ItemTooltip', description = '', stats = [] } = {}) {
		this.type = type
		this.description = description
		this.stats = stats
	}
}
