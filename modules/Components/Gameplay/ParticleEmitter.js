/**
 * A "cold" component that defines the properties of a particle emitter.
 * This is used by a ParticleSystem to spawn and manage particles associated
 * with an entity.
 */
export class ParticleEmitter {
	// No static schema = this is a "cold" component (Array-of-Structs).
	constructor(data = {}) {
		Object.assign(this, data)
	}
}