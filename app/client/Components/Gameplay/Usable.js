/**
 * A component that defines what happens when an item is "used".
 * This is typically found on skill or consumable item prefabs.
 * Its properties should be marked as `shared: true` in prefabs.
 */
export const Usable = {
	/**
	 * The name of the prefab to spawn when this item is used.
	 * For example, a "Fireball" skill item would spawn a "fireball_projectile" prefab.
	 */
	spawnPrefab: {
		type: 'string',
		default: '',
	},
}