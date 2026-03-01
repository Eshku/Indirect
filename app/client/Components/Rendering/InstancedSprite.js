/**
 * Component for entities rendered by the InstancedRenderSystem.
 * Specifies the asset to use from the texture atlas and its anchor point.
 */
export const InstancedSprite = {
	/**
	 * The name of the asset in the texture atlas (e.g., 'player_ship').
	 * This will be interned by the String Interning Table.
	 */
	assetName: {
		type: 'string',
		default: '',
	},
	/**
	 * The anchor point for the sprite (0.0 to 1.0).
	 * A value of 0.5 means the center of the sprite.
	 */
	anchor: {
		type: 'f32',
		default: 0.5,
	},
}