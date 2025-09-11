/**
 * A shared component that defines the rarity of an item.
 */
export const Rarity = {
	/**
	 * The rarity value (e.g., 'Common', 'Rare', 'Legendary').
	 * This is a shared property, meaning many items of the same type
	 * will share a single instance of this value.
	 */
	value: {
		type: 'string',
		shared: true,
		default: '',
	},
}
