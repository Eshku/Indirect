export class Scaling {
	static schema = {
		stat: {
			type: 'enum',
			of: 'u8',
			values: ['Strength', 'Dexterity', 'Intelligence', 'Vitality'],
		},
		type: {
			type: 'enum',
			of: 'u8',
			values: ['Additive', 'Multiplicative'],
		},
		multiplier: 'f32',
	}

	constructor({ stat = 0, type = 0, multiplier = 0 } = {}) {
		this.stat = stat
		this.type = type
		this.multiplier = multiplier
	}
}