/**
 * A component for testing the 'enableable' feature.
 */
export const enableableTestComponent = {
	// Special metadata flag. This is not a data property, but a schema flag.
	isEnableable: true,

	// Regular data property, defined as an object.
	value: { type: 'f32' },
}