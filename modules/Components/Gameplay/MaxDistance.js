/**
 * A "hot" component that defines the maximum distance a projectile can travel
 * before it is destroyed.
 */
export class MaxDistance {
	static schema = {
		value: 'f32',
	}
	constructor({ value = 1000 } = {}) {
		this.value = value
	}
}