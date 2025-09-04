/**
 * A "hot" component that manages the directional collision state of an entity.
 * This is set by the CollisionSystem and can be read by other physics systems
 * like those for wall-jumps or sliding.
 */
export class CollisionFlags {
	static schema = {
		collisionFlags: {
			type: 'bitmask',
			of: ['NONE', 'TOP', 'BOTTOM', 'LEFT', 'RIGHT'],
		},
	}

	constructor({ collisionFlags = CollisionFlags.COLLISIONFLAGS.NONE } = {}) {
		this.collisionFlags = collisionFlags
	}
}