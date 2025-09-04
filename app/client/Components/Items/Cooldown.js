export class Cooldown {
	/**
	 * The schema defines the actual data stored in the archetype's TypedArrays.
	 * @type {{duration: string}}
	 */
	static schema = {
		duration: 'f32',
	}
	/**
	 * A data-only component that defines the base cooldown duration for an item or skill.
	 * This component exists on prefabs (e.g., in a JSON file) to provide the static
	 * "blueprint" data for a skill.
	 *
	 *
	 * @param {object} [props]
	 * @param {number} [props.duration=0] - The base cooldown duration in seconds.
	 */
	constructor({ duration = 0 } = {}) {
		/**
		 * The base cooldown duration in seconds.
		 * @type {number}
		 */
		this.duration = duration
	}
}