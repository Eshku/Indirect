/**
 * A component that stores the unique 'key' of a child entity as defined
 * in its parent's prefab definition. This allows systems to reliably find
 * specific child entities for relational queries.
 */
export const prefabChildKey = {
	/**
	 * The unique key of the child entity.
	 */
	key: {
		type: 'string',
		default: '',
	},
}
