/**
 * Represents the Strength stat of an entity.
 * Affects health, regeneration, and physical resistance.
 */
export class Strength {
	static schema = {
		value: 'f32',
	}

	constructor({ value = 0 } = {}) {
		this.value = value
	}
}
