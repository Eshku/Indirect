/**
 * @fileoverview A "cold" component that stores per-instance modifications for a skill.
 * This allows a specific item entity (e.g., an upgraded Fireball) to override
 * the base values defined in its prefab template when its effects are created.
 */
export class SkillModifiers {
	/**
	 * @param {object} overrides - An object where keys match the 'key' of child
	 * entities in the prefab, and values are objects of component data to merge.
	 *
	 * @example
	 * {
	 *   "dealDamage_fire": {
	 *     "dealDamage": { "baseValue": 50 }
	 *   },
	 *   "spawnProjectile_main": { ... }
	 * }
	 */
	constructor({ overrides = {} } = {}) {
		this.overrides = overrides
	}
}