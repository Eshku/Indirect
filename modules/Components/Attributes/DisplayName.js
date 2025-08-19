/**
 * A component that stores a human-readable display name for an entity.
 * This component uses the engine's string interning system for high performance.
 * @param {object} [props] - The properties for the display name.
 * @param {string} [props.value=''] - The display name of the entity (e.g., "Health Potion", "Grommash").
 */
export class DisplayName {
	static schema = {
		// The key 'value' is the property name on the component instance.
		// The definition object tells the engine to use the StringManager.
		value: { type: 'string' },
	}

	/**
	 * The constructor is for defining default values for the user-facing data structure.
	 * It is NOT what is stored in the archetype for this component type.
	 * @param {object} [options={}]
	 * @param {string} [options.value='']
	 */
	constructor({ value = '' } = {}) {
		this.value = value
	}
}
