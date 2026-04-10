/**
 * Describes the visual representation of an entity to be created by the SpriteFactorySystem.
 */
export const spriteDescriptor = {
	meta: { isTrackable: true },
	/**
	 * The name of the asset in the texture atlas (e.g., 'player_ship').
	 * This will be interned by the String Interning Table.
	 */
	assetName: { type: 'string', default: '' },
}