/**
 * A test component to verify the interaction between shorthands and default values.
 */
export const ShorthandDefaultComponent = {
	// The property used for shorthand
	value: { type: 'i32', default: -1 },
	// The property that should be filled by default
	text: { type: 'string', default: 'default_text' },
}