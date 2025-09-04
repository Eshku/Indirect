/**
 * A component that stores a descriptive text for an entity, like item flavor text.
 * This component uses the engine's string interning system for high performance.
 */
export class Description {
	/**
	 * A declarative schema that tells the ComponentManager how to store this component's data.
	 */
	static schema = {
		value: 'string',
	}

	constructor({ value = '' } = {}) {
		this.value = value
	}
}
