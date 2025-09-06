/**
 * @fileoverview Tests the 'bitmask' schema type.
 */
export class BitmaskComponent {
	static schema = {
		flags: { type: 'bitmask', of: ['FLAG_A', 'FLAG_B', 'FLAG_C', 'FLAG_D'] },
	}

	constructor({ flags = [] } = {}) {
		this.flags = flags
	}
}