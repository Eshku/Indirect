/**
 * A component that holds the static data needed to construct a tooltip.
 */
export const Tooltip = {
	/**
	 * The name of the UI view to use for rendering this tooltip.
	 */
	type: {
		type: 'string',
		default: 'ItemTooltip',
	},
	/**
	 * The main descriptive text for the tooltip.
	 */
	description: {
		type: 'string',
		default: '',
	},
	/**
	 * A list of stat names to resolve and display in the tooltip.
	 */
	stats: {
		type: 'flat_array',
		of: 'string',
		capacity: 10,
		default: [],
	},
}
