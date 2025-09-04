/**
 * Represents the rarity level of an item or entity.
 * This component uses the engine's string interning system for high performance.
 */
export class Rarity {
	static schema = {
		value: 'string',
	}

	/**
	 * @param {object} data
	 * @param {string} [data.value='common'] - The rarity level (e.g., 'common', 'uncommon', 'rare').
	 */
	constructor({ value = 'common' } = {}) {
		this.value = value
	}
}
