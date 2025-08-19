/**
 * A "hot" component representing the target of an action or effect.
 * This uses a "tagged union" pattern, where the `type` property (an enum)
 * determines which of the other properties are relevant.
 */
export class Target {
	static schema = {
		/** The type of target. See Target.TYPE for values. */
		type: {
			type: 'enum',
			of: 'u8',
			values: ['None', 'Entity', 'Position', 'Direction'],
		},
		/** The entity ID, if type is 'Entity'. */
		entityId: 'u32',
		/** The X coordinate or direction component. */
		x: 'f64',
		/** The Y coordinate or direction component. */
		y: 'f64',
	}

	constructor({ type = 'None', entityId = 0, x = 0, y = 0 } = {}) {
		this.type = type
		this.entityId = entityId
		this.x = x
		this.y = y
	}
}