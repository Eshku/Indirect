/**
 * A component representing the target of an action or effect.
 * This uses a "tagged union" pattern, where the `type` property
 * determines which of the other properties are relevant.
 */
export const Target = {
	/** The type of target. */
	type: {
		type: 'enum',
		of: ['None', 'Entity', 'Position', 'Direction'],
		default: 'None',
	},
	/** The entity ID, if type is 'Entity'. */
	entityId: {
		type: 'u32',
		default: 0,
	},
	/** The X coordinate or direction component. */
	x: {
		type: 'f64',
		default: 0,
	},
	/** The Y coordinate or direction component. */
	y: {
		type: 'f64',
		default: 0,
	},
}
