/**
 * A "hot" component that defines the travel speed of an entity, typically a projectile.
 * This is used by systems to calculate the entity's Velocity vector.
 */
export class Speed {
	static schema = {
		value: 'f32',
	}
	constructor({ value = 500 } = {}) {
		this.value = value
	}
}