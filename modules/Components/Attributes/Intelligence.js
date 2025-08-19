/**
 * Represents the Intelligence stat of an entity.
 * Affects cooldowns, status effect potency, and magical damage.
 */
export class Intelligence {
	static schema = {
		value: { type: 'f32' },
	}

	constructor({ value = 0 } = {}) {
		this.value = value
	}
}
