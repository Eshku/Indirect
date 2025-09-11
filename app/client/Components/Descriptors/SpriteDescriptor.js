/**
 * A data-only "descriptor" component that specifies an entity should be
 * rendered using a sprite from a pre-loaded asset.
 */
export const SpriteDescriptor = {
	/**
	 * The name of the asset in the AssetManager. This will be interned by the String Interning Table.
	 */
	assetName: {
		type: 'string',
		default: '',
	},
}
