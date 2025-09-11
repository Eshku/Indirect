/**
 * A component that stores a human-readable display name for an entity.
 * This component uses the engine's string interning system for high performance.
 */
export const DisplayName = {
	/**
	 * The display name of the entity (e.g., "Health Potion", "Grommash").
	 * This will be interned by the String Interning Table.
	 */
	value: {
		type: 'string',
		default: '',
	},
}
