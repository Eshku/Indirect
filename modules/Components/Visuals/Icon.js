/**
 * A component that holds the asset name for an entity's icon.
 * The assetName is stored as a shared/interned string for memory efficiency,
 * meaning that even if 1000 entities have the same icon, the string for its
 * asset name is only stored once in memory.
 */
export class Icon {
	static schema = {
		assetName: { type: 'string'},
	}
	constructor({ assetName = '' } = {}) {
		this.assetName = assetName
	}
}