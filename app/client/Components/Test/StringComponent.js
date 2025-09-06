/**
 * @fileoverview Tests the 'string' schema type for interned strings.
 */
export class StringComponent {
	static schema = {
		value: 'string',
	}

	constructor({ value = '' } = {}) {
		this.value = value
	}
}