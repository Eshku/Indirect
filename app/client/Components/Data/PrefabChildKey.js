/**
 * A component that stores the unique 'key' of a child entity as defined
 * in its parent's prefab definition. This allows systems to reliably find
 * specific child entities for relational queries, such as a TooltipSystem
 * looking for a specific damage effect to read its value.
 */
export class PrefabChildKey {
	static schema = {
		key: 'string',
	}

	constructor({ key = '' } = {}) {
		this.key = key
	}
}
