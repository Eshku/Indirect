/**
 * @fileoverview Tests the 'enum' schema type.
 */
export class EnumComponent {
	static schema = {
		state: { type: 'enum', of: ['IDLE', 'RUNNING', 'JUMPING'] },
	}

	constructor({ state = 'IDLE' } = {}) {
		this.state = state
	}
}