/**
 * Stores a string identifier for the prefab that an entity was created from.
 * This is used to look up static configuration data or manage shared state
 * in global resources. This component uses the engine's string interning system
 * for high performance.
 */
export class PrefabId {
	static schema = {
		id: { type: 'string' },
	}

	constructor({ id = '' } = {}) {
		this.id = id
	}
}
