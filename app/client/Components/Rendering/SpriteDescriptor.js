/**
 * Describes the visual representation of an entity to be created by the SpriteFactorySystem.
 */
export const SpriteDescriptor = {
	/**
	 * The name of the asset in the texture atlas (e.g., 'player_ship').
	 * This will be interned by the String Interning Table.
	 */
	assetName: {
		type: 'string',
		default: '',
	},
	/**
	 * The game tick when this component was last modified.
	 * Used for fine-grained reactive change detection.
	 */
	dirtyTick: { type: 'u32', default: 0 },
}