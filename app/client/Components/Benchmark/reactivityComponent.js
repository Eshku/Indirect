/**
 * A component with a value that we can change to trigger reactivity.
 */
export const reactivityComponent = {
	meta: { isTrackable: true },

	value: {
		type: 'u32',
		default: 0,
	},
}
