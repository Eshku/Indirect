/**
 * Represents the Dexterity stat of an entity.
 * Affects attack speed, movement speed, and critical/dodge chances.
 */
export class Dexterity {
	static schema = {
		value: { type: 'f32' },
	}

	constructor({ value = 0 } = {}) {
		this.value = value
	}
}
