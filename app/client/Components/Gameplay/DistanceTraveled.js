/**
 * A "hot" component that tracks the distance a projectile has traveled since
 * it was spawned. Used by the ProjectileLifetimeSystem to check against MaxDistance.
 * It is initialized to zero when the projectile is created.
 */
export class DistanceTraveled {
	static schema = {
		value: 'f32',
	}
	constructor({ value = 0 } = {}) {
		this.value = value
	}
}