/**
 * A "hot" runtime component that stores damage data in parallel arrays.
 * This allows a single skill to inflict multiple types of damage, each
 * with its own base value and scaling formula.
 */

/* myEntityManager.createEntity({
    Position: { x: 100, y: 200 },
    Damage: {
        types: ['Physical', 'Fire'],
        baseValues: [15, 8]
    }
}) */
export class Damage {
	static schema = {
		/**
		 * An array of damage types. The value is an integer index for the enum defined below.
		 */
		types: {
			type: 'flat_array',
			of: {
				type: 'enum',
				of: ['Physical', 'Fire', 'Ice', 'Lightning', 'Poison'],
			},
			capacity: 5,
		},

		/**
		 * An array of base damage values, corresponding to each type in the `types` array.
		 */
		baseValues: {
			type: 'flat_array',
			of: 'f32',
			capacity: 5,
		},

		/**
		 * An array of formula strings, corresponding to each damage instance.
		 * The 'rpn' processor will compile these into efficient bytecode.
		 */
		formulas: {
			type: 'rpn',
			streamCapacity: 128, // Total tokens for all formulas on this component
			instanceCapacity: 5, // Max number of formulas (must match other arrays)
		},
	}

	constructor() {
		// The component's data is managed by the ECS.
		// Default values will be 0.
	}
}
