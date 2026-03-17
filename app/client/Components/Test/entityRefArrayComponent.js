/**
 * A test component for a flat_array of entity references.
 */
export const entityRefArrayComponent = {
	targets: {
		type: 'flat_array',
		of: 'entity',
		capacity: 3,
		default: [],
	},
}