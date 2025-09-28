/**
 * Damage data in parallel arrays.
 * This allows a single skill to inflict multiple types of damage, each
 * with its own base value and scaling formula.
 */
export const Damage = {
	/**
	 * An array of damage types.
	 */
	types: {
		type: 'flat_array',
		of: {
			type: 'enum',
			of: {
				Physical: 0,
				Fire: 1,
				Ice: 2,
				Lightning: 3,
				Poison: 4,
			},
		},
		capacity: 5,
		default: [],
	},

	/**
	 * An array of base damage values, corresponding to each type in the `types` array.
	 */
	baseValues: {
		type: 'flat_array',
		of: 'f32',
		capacity: 5,
		default: [],
	},

	/**
	 * An array of formula strings, corresponding to each damage instance.
	 */
	formulas: {
		type: 'rpn',
		streamCapacity: 128, // Total tokens for all formulas on this component
		instanceCapacity: 5, // Max number of formulas (must match other arrays)
		default: [],
	},
}
