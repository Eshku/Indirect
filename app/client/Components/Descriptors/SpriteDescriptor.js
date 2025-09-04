/**
 * A data-only "descriptor" component that specifies an entity should be
 * rendered using a sprite from a pre-loaded asset. This component uses the
 * engine's string interning system for high performance.
 */
export class SpriteDescriptor {
	static schema = {
		assetName: 'string',
	}

	constructor({ assetName = '' } = {}) {
		/** @type {string} The name of the asset in the AssetManager. */
		this.assetName = assetName
	}
}
