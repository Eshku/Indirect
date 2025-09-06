/**
 * @fileoverview Tests the 'flat_array' schema type with various underlying data types.
 */
export class FlatArrayComponent {
	static schema = {
		primitiveArray: { type: 'flat_array', of: 'i32', capacity: 5 },
		enumArray: {
			type: 'flat_array',
			of: { type: 'enum', of: ['VAL1', 'VAL2'] },
			capacity: 3,
		},
		stringArray: { type: 'flat_array', of: 'string', capacity: 4 },
	}

	constructor(data = {}) {
		Object.assign(
			this,
			{
				primitiveArray: [],
				enumArray: [],
				stringArray: [],
			},
			data
		)
	}
}
