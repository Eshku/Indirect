/**
 * A component with a value that we can change to trigger reactivity.
 */
export class ReactivityComponent {
	static schema = {
		value: 'u32',
	}
	constructor({ value = 0 } = {}) {
		this.value = value
	}
}