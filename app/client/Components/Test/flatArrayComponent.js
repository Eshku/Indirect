/**
 * component for testing the 'flat_array' schema type with various underlying data types.
 */
export const flatArrayComponent = {
	primitiveArray: {
		type: 'flat_array',
		of: 'i32',
		capacity: 5,
		default: [],
	},
	enumArray: {
		type: 'flat_array',
		of: {
			type: 'enum',
			of: {
				VAL1: 0,
				VAL2: 1,
			},
		},
		capacity: 3,
		default: [],
	},
	stringArray: {
		type: 'flat_array',
		of: 'string',
		capacity: 4,
		default: [],
	},
}
